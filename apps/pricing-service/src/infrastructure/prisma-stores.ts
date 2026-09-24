import { v7 as uuidv7 } from 'uuid'
import { fromColumns, isCurrency, type Currency } from '@tbe/money'
import { markupRuleSchema, type MarkupRule } from '../domain/markup.js'
import type { ExchangeRate } from '../domain/pricing.js'
import type { MarkupRulePatch, MarkupRuleStore, RateProvider } from '../application/ports.js'
import type {
  ExchangeRate as ExchangeRateRow,
  MarkupRule as MarkupRuleRow,
  PrismaClient,
} from '../generated/prisma/client.js'

/**
 * Penyimpanan aturan markup dan kurs.
 *
 * Keduanya memuat SELURUH baris sekali, bukan mencari satu per satu. Tabelnya
 * kecil — puluhan aturan, segelintir kurs — dan penyaringan di memori jauh
 * lebih murah daripada satu kueri per rate plan pada jalur kritis pencarian.
 */

function toRule(row: MarkupRuleRow): MarkupRule | undefined {
  const fixedAmount =
    row.fixedAmountMinor === null || row.fixedCurrency === null
      ? undefined
      : fromColumns(row.fixedAmountMinor, row.fixedCurrency)

  const parsed = markupRuleSchema.safeParse({
    id: row.id,
    name: row.name,
    priority: row.priority,
    scope: {
      ...(row.supplier === null ? {} : { supplier: row.supplier }),
      ...(row.city === null ? {} : { city: row.city }),
    },
    kind: row.kind,
    ...(row.percentageBasisPoints === null
      ? {}
      : { percentageBasisPoints: row.percentageBasisPoints }),
    ...(fixedAmount === undefined ? {} : { fixedAmount }),
    isActive: row.isActive,
  })

  // Baris yang tidak lolos skema dilewati, bukan menggagalkan seluruh
  // pemuatan. Satu aturan yang rusak tidak boleh membuat seluruh pencarian
  // kehilangan harganya — tetapi ia juga tidak boleh diam-diam dipakai.
  return parsed.success ? parsed.data : undefined
}

/**
 * Memuat aturan.
 *
 * Baris yang tidak lolos skema DILEWATI, bukan menggagalkan seluruh pemuatan:
 * satu aturan yang rusak tidak boleh membuat seluruh pencarian kehilangan
 * harganya. Tetapi ia juga tidak boleh diam-diam dipakai, jadi setiap baris
 * yang dilewati dilaporkan.
 */
async function loadRules(
  prisma: PrismaClient,
  where: { isActive?: boolean },
  onInvalidRow: (id: string) => void,
): Promise<readonly MarkupRule[]> {
  const rows = await prisma.markupRule.findMany({
    where,
    orderBy: [{ priority: 'desc' }, { id: 'asc' }],
  })

  const rules: MarkupRule[] = []
  for (const row of rows) {
    const rule = toRule(row)
    if (rule === undefined) {
      onInvalidRow(row.id)
      continue
    }

    rules.push(rule)
  }

  return rules
}

async function createRule(prisma: PrismaClient, rule: Omit<MarkupRule, 'id'>): Promise<MarkupRule> {
  const row = await prisma.markupRule.create({
    data: {
      id: uuidv7(),
      name: rule.name,
      priority: rule.priority,
      supplier: rule.scope.supplier ?? null,
      city: rule.scope.city ?? null,
      kind: rule.kind,
      percentageBasisPoints: rule.percentageBasisPoints ?? null,
      fixedAmountMinor: rule.fixedAmount?.amountMinor ?? null,
      fixedCurrency: rule.fixedAmount?.currency ?? null,
      isActive: rule.isActive,
    },
  })

  const created = toRule(row)
  if (created === undefined) throw new Error('aturan markup yang baru dibuat tidak sah')

  return created
}

async function updateRule(
  prisma: PrismaClient,
  id: string,
  patch: MarkupRulePatch,
): Promise<MarkupRule | undefined> {
  const existing = await prisma.markupRule.findUnique({ where: { id } })
  if (existing === null) return undefined

  const row = await prisma.markupRule.update({
    where: { id },
    data: {
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.priority === undefined ? {} : { priority: patch.priority }),
      ...(patch.percentageBasisPoints === undefined
        ? {}
        : { percentageBasisPoints: patch.percentageBasisPoints }),
      ...(patch.isActive === undefined ? {} : { isActive: patch.isActive }),
    },
  })

  return toRule(row)
}

/**
 * Menonaktifkan aturan, bukan menghapusnya.
 *
 * Harga pemesanan yang sudah terjadi merujuk aturan ini lewat
 * `appliedMarkupRuleId`, dan baris yang hilang membuat pertanyaan "kenapa
 * harganya segitu" tidak dapat dijawab lagi.
 */
async function deactivateRule(prisma: PrismaClient, id: string): Promise<boolean> {
  const existing = await prisma.markupRule.findUnique({ where: { id } })
  if (existing === null) return false

  await prisma.markupRule.update({ where: { id }, data: { isActive: false } })
  return true
}

export function createPrismaMarkupRuleStore(
  prisma: PrismaClient,
  onInvalidRow: (id: string) => void,
): MarkupRuleStore {
  return {
    listActive: async () => await loadRules(prisma, { isActive: true }, onInvalidRow),
    listAll: async () => await loadRules(prisma, {}, onInvalidRow),
    create: async (rule) => await createRule(prisma, rule),
    update: async (id, patch) => await updateRule(prisma, id, patch),
    remove: async (id) => await deactivateRule(prisma, id),
  }
}

function toRate(row: ExchangeRateRow): ExchangeRate | undefined {
  if (!isCurrency(row.fromCurrency) || !isCurrency(row.toCurrency)) return undefined

  return {
    from: row.fromCurrency satisfies Currency,
    to: row.toCurrency,
    rate: { amount: row.rate, scale: row.scale },
    asOf: row.effectiveFrom.toISOString(),
  }
}

/**
 * Kurs yang berlaku.
 *
 * Mengambil baris terbaru per pasangan mata uang, bukan seluruh riwayat.
 * Riwayatnya tetap tersimpan — itulah yang membuat harga pemesanan lama dapat
 * dijelaskan — tetapi penetapan harga hari ini hanya memerlukan yang terbaru.
 */
export function createPrismaRateProvider(prisma: PrismaClient): RateProvider {
  return {
    async current(): Promise<readonly ExchangeRate[]> {
      const rows = await prisma.exchangeRate.findMany({
        where: { effectiveFrom: { lte: new Date() } },
        orderBy: { effectiveFrom: 'desc' },
      })

      const latest = new Map<string, ExchangeRate>()
      for (const row of rows) {
        const rate = toRate(row)
        if (rate === undefined) continue

        const key = `${rate.from}->${rate.to}`
        if (!latest.has(key)) latest.set(key, rate)
      }

      return [...latest.values()]
    },
  }
}
