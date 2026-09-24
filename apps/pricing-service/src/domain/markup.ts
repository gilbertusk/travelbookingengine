import { z } from 'zod'
import { moneySchema, type Money } from '@tbe/money'
import { SUPPLIER_CODES } from '@tbe/supplier-adapters'

/**
 * Aturan markup.
 *
 * Satu aturan berlaku untuk cakupan tertentu: global, satu supplier, satu
 * kota, atau kombinasi keduanya. Lebih dari satu aturan dapat cocok untuk
 * permintaan yang sama, dan yang menentukan mana yang dipakai HARUS dapat
 * diuji — bukan bergantung pada urutan baris di basis data.
 */

export const MARKUP_KINDS = ['percentage', 'fixed'] as const
export type MarkupKind = (typeof MARKUP_KINDS)[number]

export const markupScopeSchema = z.object({
  supplier: z.enum(SUPPLIER_CODES).optional(),
  /** Dicocokkan tanpa memedulikan huruf besar-kecil. */
  city: z.string().min(1).optional(),
})

export type MarkupScope = z.infer<typeof markupScopeSchema>

export const markupRuleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /**
   * Angka lebih besar menang. Dinyatakan operator, bukan disimpulkan sistem —
   * operator yang memberi satu supplier markup khusus perlu cara menyatakan
   * bahwa aturannya mengalahkan aturan kota.
   */
  priority: z.number().int(),
  scope: markupScopeSchema,
  kind: z.enum(MARKUP_KINDS),
  /**
   * Dalam basis poin: 1250 berarti 12,5%. Bilangan bulat, bukan pecahan —
   * `0.125` yang tersimpan sebagai float adalah cara paling halus membuat
   * markup meleset.
   */
  percentageBasisPoints: z.number().int().min(0).max(100_000).optional(),
  fixedAmount: moneySchema.optional(),
  isActive: z.boolean(),
})

export type MarkupRule = z.infer<typeof markupRuleSchema>

/**
 * Seberapa khusus sebuah cakupan.
 *
 * Dipakai sebagai pemutus ketika dua aturan punya prioritas sama. Aturan yang
 * menyebut supplier DAN kota lebih khusus daripada yang hanya menyebut salah
 * satunya, dan aturan global paling umum. Tanpa pemutus ini, dua aturan
 * berprioritas sama akan dipilih menurut urutan baris — dan urutan baris
 * berubah setiap kali ada yang diedit.
 */
export function specificity(scope: MarkupScope): number {
  return (scope.supplier === undefined ? 0 : 2) + (scope.city === undefined ? 0 : 1)
}

function matchesScope(scope: MarkupScope, request: MarkupRequest): boolean {
  if (scope.supplier !== undefined && scope.supplier !== request.supplier) return false
  if (scope.city !== undefined && scope.city.toLowerCase() !== request.city.toLowerCase()) {
    return false
  }

  return true
}

export interface MarkupRequest {
  readonly supplier: string
  readonly city: string
}

/**
 * Aturan yang berlaku untuk satu permintaan.
 *
 * Satu aturan saja, bukan gabungan beberapa. Markup yang ditumpuk membuat
 * harga akhir mustahil dijelaskan kepada operator yang bertanya "kenapa
 * harganya segini", dan mustahil dibatalkan sebagian.
 *
 * Urutan pemilihan: prioritas tertinggi, lalu cakupan paling khusus, lalu
 * pengenal terkecil. Yang terakhir hanya pemutus terakhir supaya hasilnya
 * deterministik — bukan karena pengenal punya arti.
 */
export function selectRule(
  rules: readonly MarkupRule[],
  request: MarkupRequest,
): MarkupRule | undefined {
  const candidates = rules
    .filter((rule) => rule.isActive && matchesScope(rule.scope, request))
    .sort(byPrecedence)

  return candidates[0]
}

function byPrecedence(a: MarkupRule, b: MarkupRule): number {
  if (a.priority !== b.priority) return b.priority - a.priority

  const bySpecificity = specificity(b.scope) - specificity(a.scope)
  if (bySpecificity !== 0) return bySpecificity

  return a.id.localeCompare(b.id)
}

/**
 * Markup yang benar-benar diterapkan.
 *
 * Aturan persentase menjadi faktor pengali; aturan nominal tetap menjadi
 * jumlah uang. Keduanya dipisahkan di sini supaya perhitungan di
 * [calculatePrice] tidak perlu tahu bentuk aturannya.
 */
export type ResolvedMarkup =
  | { readonly kind: 'percentage'; readonly basisPoints: number; readonly ruleId: string }
  | { readonly kind: 'fixed'; readonly amount: Money; readonly ruleId: string }
  /** Tidak ada aturan yang cocok. Harga jual sama dengan harga dasar. */
  | { readonly kind: 'none' }

export function resolveMarkup(rule: MarkupRule | undefined): ResolvedMarkup {
  if (rule === undefined) return { kind: 'none' }

  if (rule.kind === 'percentage') {
    // Aturan persentase tanpa angka persentasenya adalah aturan yang rusak.
    // Diperlakukan sebagai tidak ada markup, bukan sebagai nol persen yang
    // diam-diam benar — perbedaannya terlihat di rincian harga.
    if (rule.percentageBasisPoints === undefined) return { kind: 'none' }

    return { kind: 'percentage', basisPoints: rule.percentageBasisPoints, ruleId: rule.id }
  }

  if (rule.fixedAmount === undefined) return { kind: 'none' }

  return { kind: 'fixed', amount: rule.fixedAmount, ruleId: rule.id }
}
