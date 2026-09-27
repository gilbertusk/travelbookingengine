import { err, ok, type Result } from '@tbe/shared-kernel'

/**
 * Tanggal menginap: tanggal kalender lokal properti, BUKAN titik waktu.
 *
 * NFR-09 dan CONVENTIONS.md bagian 9. Check-in 10 November berarti 10 November
 * di properti itu, apa pun zona waktu server yang memprosesnya. Karena itu
 * bentuknya di domain adalah string `YYYY-MM-DD`, bukan `Date`.
 *
 * `Date` ditolak dengan sengaja, walau terasa lebih "bertipe". `Date` adalah
 * titik waktu; menyimpan tanggal kalender di dalamnya memaksa setiap pembaca
 * memilih zona untuk menafsirkannya kembali, dan pilihan yang salah menggeser
 * seluruh menginap satu hari — hanya pada server yang zonanya kebetulan berbeda,
 * hanya untuk pemesanan di sekitar tengah malam. Satu-satunya tempat string ini
 * berubah menjadi `Date` adalah pemetaan kolom `DATE` di infrastructure, dan di
 * sana pun secara eksplisit dalam UTC.
 */

declare const localDateBrand: unique symbol

/**
 * String `YYYY-MM-DD` yang sudah terbukti tanggal sungguhan.
 *
 * Bermerek supaya string sembarang — termasuk `2026-11-10T00:00:00Z` — tidak
 * dapat dipakai sebagai tanggal menginap tanpa melewati [parseLocalDate].
 */
export type LocalDate = string & { readonly [localDateBrand]: true }

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * Batas lama menginap dalam satu pemesanan.
 *
 * Bukan batas supplier, melainkan batas akal sehat: pemesanan 400 malam hampir
 * pasti tanggal yang salah ketik, dan menolaknya di sini lebih murah daripada
 * menahan inventaris supplier selama satu tahun.
 */
export const MAX_NIGHTS = 30

const MS_PER_DAY = 86_400_000

export function parseLocalDate(value: string): LocalDate | undefined {
  const match = LOCAL_DATE.exec(value)
  if (match === null) return undefined

  const [, year = '', month = '', day = ''] = match
  const epochMs = Date.UTC(Number(year), Number(month) - 1, Number(day))

  // Date.UTC menerima 31 Februari dan diam-diam menjadikannya 3 Maret. Tanggal
  // yang tidak ada harus ditolak di perbatasan, bukan menjadi tanggal lain.
  if (new Date(epochMs).toISOString().slice(0, 10) !== value) return undefined

  // Satu-satunya type assertion di berkas ini, dan memang tempatnya: merek
  // hanya dapat dilekatkan oleh fungsi yang baru saja membuktikannya.
  return value as LocalDate
}

export interface StayDates {
  readonly checkIn: LocalDate
  readonly checkOut: LocalDate
}

export type StayDatesError =
  | { readonly kind: 'invalid_date'; readonly field: 'checkIn' | 'checkOut' }
  | { readonly kind: 'check_out_not_after_check_in' }
  | { readonly kind: 'too_many_nights'; readonly nights: number }

export function stayDates(input: {
  readonly checkIn: string
  readonly checkOut: string
}): Result<StayDates, StayDatesError> {
  const checkIn = parseLocalDate(input.checkIn)
  if (checkIn === undefined) return err({ kind: 'invalid_date', field: 'checkIn' })

  const checkOut = parseLocalDate(input.checkOut)
  if (checkOut === undefined) return err({ kind: 'invalid_date', field: 'checkOut' })

  const stay = { checkIn, checkOut }
  const count = nights(stay)

  if (count < 1) return err({ kind: 'check_out_not_after_check_in' })
  if (count > MAX_NIGHTS) return err({ kind: 'too_many_nights', nights: count })

  return ok(stay)
}

/**
 * Banyak malam.
 *
 * Dihitung atas tengah malam UTC kedua tanggal, bukan atas zona mesin. Dengan
 * zona lokal, menginap yang melintasi pergantian jam musim panas di zona server
 * menjadi 23 atau 25 jam, dan pembagian dengan 24 jam memberi 0,96 malam.
 */
export function nights(stay: StayDates): number {
  return Math.round((utcMidnight(stay.checkOut) - utcMidnight(stay.checkIn)) / MS_PER_DAY)
}

function utcMidnight(date: LocalDate): number {
  return Date.parse(`${date}T00:00:00Z`)
}
