import { allocate, zero, type Money } from '@tbe/money'
import { err, ok, type Result } from '@tbe/shared-kernel'
import type { CancellationPolicy } from './offer-terms.js'
import { startOfLocalDate } from './property-time.js'
import type { LocalDate } from './stay-dates.js'

/**
 * Jadwal pengembalian dana saat pembatalan (Step 25, FR-27, keputusan Q3).
 *
 * Kebijakan dinyatakan sebagai DAFTAR JENJANG TERURUT, bukan rangkaian
 * percabangan. Jenjang dibaca dari atas: yang pertama yang batas jamnya sudah
 * terpenuhi adalah yang berlaku. Rate plan yang berbeda punya daftar yang
 * berbeda, dan menambah jenjang berarti menambah satu baris data — tidak
 * menyentuh satu `if` pun.
 *
 * Jadwal DISIMPAN bersama pemesanan saat harganya diverifikasi ke supplier,
 * bukan diturunkan ulang saat pembatalan. Yang mengikat adalah kebijakan yang
 * disepakati saat memesan: jenjang bawaan yang diubah bulan depan tidak boleh
 * mengubah berapa yang dikembalikan untuk pemesanan hari ini.
 */

export interface RefundTier {
  /**
   * Jenjang ini berlaku selama pembatalan terjadi SETIDAKNYA sekian jam sebelum
   * awal tanggal masuk di zona waktu properti. Batasnya inklusif: tepat 168 jam
   * sebelumnya masih jenjang 168 jam.
   */
  readonly minHoursBefore: number
  /** Bagian pembayaran yang dikembalikan, bilangan bulat 0–100. */
  readonly percent: number
}

declare const scheduleBrand: unique symbol

/** Jadwal yang sudah lolos [refundSchedule]. */
export interface RefundSchedule {
  readonly tiers: readonly RefundTier[]
  readonly [scheduleBrand]: true
}

export type RefundScheduleError =
  | { readonly kind: 'empty' }
  | { readonly kind: 'invalid_hours' }
  | { readonly kind: 'invalid_percent' }
  /** Batas jam tidak menurun dari atas ke bawah. */
  | { readonly kind: 'not_ordered' }
  /** Dua jenjang dengan batas jam yang sama — mana yang berlaku tidak dapat diputuskan. */
  | { readonly kind: 'overlapping' }
  /** Jenjang terakhir berhenti sebelum tanggal masuk; ada jam tanpa kebijakan. */
  | { readonly kind: 'gap_before_check_in' }
  /** Pengembalian membesar mendekati tanggal masuk. Hampir pasti salah ketik. */
  | { readonly kind: 'refund_increases' }

const HOURS_PER_DAY = 24
const MS_PER_HOUR = 3_600_000

/** Keputusan Q3: 100% sampai 7 hari sebelum tanggal masuk, 50% sampai 24 jam, 0% setelahnya. */
export const DEFAULT_REFUND_TIERS: readonly RefundTier[] = [
  { minHoursBefore: 7 * HOURS_PER_DAY, percent: 100 },
  { minHoursBefore: HOURS_PER_DAY, percent: 50 },
  { minHoursBefore: 0, percent: 0 },
]

/**
 * Jenjang yang tumpang tindih atau tidak terurut DITOLAK, tidak diurutkan atau
 * digabung diam-diam. Jadwal yang perlu diperbaiki sebelum dapat dibaca adalah
 * jadwal yang maksudnya tidak diketahui — dan menebak maksud itu berarti
 * menebak berapa uang pengguna yang kembali.
 */
export function refundSchedule(
  tiers: readonly RefundTier[],
): Result<RefundSchedule, RefundScheduleError> {
  const last = tiers.at(-1)
  if (last === undefined) return err({ kind: 'empty' })

  for (const tier of tiers) {
    if (!Number.isSafeInteger(tier.minHoursBefore) || tier.minHoursBefore < 0) {
      return err({ kind: 'invalid_hours' })
    }
    if (!Number.isInteger(tier.percent) || tier.percent < 0 || tier.percent > 100) {
      return err({ kind: 'invalid_percent' })
    }
  }

  for (const [index, tier] of tiers.entries()) {
    const previous = tiers[index - 1]
    if (previous === undefined) continue
    if (tier.minHoursBefore === previous.minHoursBefore) return err({ kind: 'overlapping' })
    if (tier.minHoursBefore > previous.minHoursBefore) return err({ kind: 'not_ordered' })
    if (tier.percent > previous.percent) return err({ kind: 'refund_increases' })
  }

  if (last.minHoursBefore !== 0) return err({ kind: 'gap_before_check_in' })

  // Satu-satunya type assertion di berkas ini, dan memang tempatnya: merek
  // hanya dapat dilekatkan oleh fungsi yang baru saja membuktikannya — pola
  // yang sama dengan `parseLocalDate`.
  const schedule = { tiers: tiers.map((tier) => ({ ...tier })) }

  return ok(schedule as unknown as RefundSchedule)
}

/**
 * Jadwal untuk kebijakan yang dijawab supplier saat price check.
 *
 * - Non-refundable: 0% kapan pun.
 * - Refundable tanpa tenggat dari supplier: jenjang Q3 apa adanya.
 * - Refundable dengan tenggat pembatalan gratis N hari: N menggantikan tujuh
 *   hari. Bila N tidak lebih dari satu hari, jenjang 50% hilang — tidak ada
 *   jarak lagi di antara "gratis" dan "24 jam".
 */
export function scheduleFor(policy: CancellationPolicy): RefundSchedule {
  return mustSchedule(tiersFor(policy))
}

function tiersFor(policy: CancellationPolicy): readonly RefundTier[] {
  if (!policy.refundable) return [{ minHoursBefore: 0, percent: 0 }]
  if (policy.freeCancellationDays === undefined) return DEFAULT_REFUND_TIERS

  const freeUntil = policy.freeCancellationDays * HOURS_PER_DAY
  if (freeUntil === 0) return [{ minHoursBefore: 0, percent: 100 }]
  if (freeUntil <= HOURS_PER_DAY) {
    return [
      { minHoursBefore: freeUntil, percent: 100 },
      { minHoursBefore: 0, percent: 0 },
    ]
  }

  return [
    { minHoursBefore: freeUntil, percent: 100 },
    { minHoursBefore: HOURS_PER_DAY, percent: 50 },
    { minHoursBefore: 0, percent: 0 },
  ]
}

/**
 * Jadwal turunan kebijakan supplier selalu sah — offer-terms.ts membatasi
 * tenggatnya 0–365 hari. Galat di sini cacat program, bukan masukan buruk.
 */
function mustSchedule(tiers: readonly RefundTier[]): RefundSchedule {
  const built = refundSchedule(tiers)
  if (!built.ok) throw new Error(`jadwal pengembalian turunan tidak sah: ${built.error.kind}`)

  return built.value
}

export interface ScheduledTier {
  readonly percent: number
  /** Titik waktu terakhir jenjang ini berlaku. */
  readonly until: Date
}

export interface RefundQuote {
  readonly percent: number
  readonly refund: Money
  /** Sampai kapan pembatalan masih mendapat persentase ini. */
  readonly until: Date
  /** Jenjang sesudahnya. `undefined` bila ini jenjang terakhir sebelum menginap. */
  readonly next: { readonly percent: number } | undefined
  /**
   * Kenapa tidak ada yang kembali, bila memang tidak ada. Dua jawaban yang
   * berbeda bagi pengguna: rate yang sejak awal tidak dapat dikembalikan, atau
   * tenggat yang sudah lewat — dan untuk yang kedua, kapan tenggat terakhirnya.
   */
  readonly nothingBack:
    | { readonly kind: 'non_refundable' }
    | { readonly kind: 'past_deadline'; readonly lastRefund: ScheduledTier }
    | undefined
  /** Seluruh jadwal sebagai titik waktu konkret, untuk ditampilkan apa adanya. */
  readonly tiers: readonly ScheduledTier[]
  /** Awal tanggal masuk di zona properti — titik acuan seluruh tenggat. */
  readonly checkInStartsAt: Date
  readonly timeZone: string
}

export type RefundQuoteError =
  | { readonly kind: 'unknown_time_zone' }
  /** Tanggal masuk sudah dimulai di properti. Pembatalan bukan lagi milik aplikasi. */
  | { readonly kind: 'stay_started' }

export interface RefundQuoteInput {
  readonly schedule: RefundSchedule
  readonly checkIn: LocalDate
  readonly timeZone: string
  readonly paid: Money
  readonly at: Date
}

/**
 * Berapa yang kembali bila pengguna membatalkan pada `at`.
 *
 * Titik acuannya awal tanggal masuk (pukul 00.00) di zona waktu properti —
 * bukan jam check-in hotel, yang tidak tercatat di data mana pun. Acuan itu
 * tidak pernah lebih longgar dari yang dijanjikan.
 *
 * Pembagian lewat `allocate`, jadi tidak ada satuan terkecil yang hilang: sisa
 * pembagian jatuh ke bagian PERTAMA, yaitu bagian yang dikembalikan.
 */
export function quoteRefund(input: RefundQuoteInput): Result<RefundQuote, RefundQuoteError> {
  const start = startOfLocalDate(input.checkIn, input.timeZone)
  if (start === undefined) return err({ kind: 'unknown_time_zone' })
  if (input.at.getTime() >= start.getTime()) return err({ kind: 'stay_started' })

  const tiers = input.schedule.tiers.map((tier) => ({
    percent: tier.percent,
    until: new Date(start.getTime() - tier.minHoursBefore * MS_PER_HOUR),
  }))
  const index = tiers.findIndex((tier) => input.at.getTime() <= tier.until.getTime())
  // Jenjang terakhir selalu berakhir tepat di awal tanggal masuk (validasi
  // `gap_before_check_in`), dan `at` sudah dipastikan sebelum titik itu.
  const current = tiers[index] as ScheduledTier
  const next = tiers[index + 1]

  return ok({
    percent: current.percent,
    refund: portionOf(input.paid, current.percent),
    until: current.until,
    next: next === undefined ? undefined : { percent: next.percent },
    nothingBack: current.percent === 0 ? whyNothingBack(tiers.slice(0, index)) : undefined,
    tiers,
    checkInStartsAt: start,
    timeZone: input.timeZone,
  })
}

function whyNothingBack(passed: readonly ScheduledTier[]): RefundQuote['nothingBack'] {
  const lastRefund = passed.findLast((tier) => tier.percent > 0)

  return lastRefund === undefined
    ? { kind: 'non_refundable' }
    : { kind: 'past_deadline', lastRefund }
}

function portionOf(paid: Money, percent: number): Money {
  if (percent === 0) return zero(paid.currency)

  const [refund] = allocate(paid, [percent, 100 - percent])

  return refund ?? zero(paid.currency)
}
