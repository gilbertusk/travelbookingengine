/**
 * Tanggal menginap.
 *
 * CONVENTIONS.md bagian 9: tanggal masuk dan keluar adalah tanggal lokal
 * properti, bukan titik waktu universal. Di sini tanggal diperlakukan sebagai
 * string YYYY-MM-DD apa adanya dan tidak pernah disentuh zona waktu — begitu
 * ia melewati konversi UTC, tamu yang menginap di Bangkok bisa terhitung
 * satu malam lebih sedikit dari yang dipesannya.
 */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
export const MAX_STAY_NIGHTS = 30

export function isDateOnly(value: string): boolean {
  return DATE_PATTERN.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
}

export function addDays(date: string, days: number): string {
  const instant = new Date(`${date}T00:00:00Z`)
  instant.setUTCDate(instant.getUTCDate() + days)
  return instant.toISOString().slice(0, 10)
}

export function nightsBetween(checkIn: string, checkOut: string): number {
  const from = Date.parse(`${checkIn}T00:00:00Z`)
  const to = Date.parse(`${checkOut}T00:00:00Z`)
  return Math.round((to - from) / 86_400_000)
}

/**
 * Malam yang ditempati. Tanggal keluar tidak termasuk — tamu tidak menginap
 * pada malam hari kepergiannya, dan menghitungnya berarti mengurangi satu
 * unit ketersediaan yang sebenarnya masih bisa dijual.
 */
export function enumerateNights(checkIn: string, checkOut: string): readonly string[] {
  const total = nightsBetween(checkIn, checkOut)
  return Array.from({ length: Math.max(total, 0) }, (_unused, index) => addDays(checkIn, index))
}

export type StayProblem = 'invalid_date' | 'not_positive' | 'too_long'

export function validateStay(checkIn: string, checkOut: string): StayProblem | undefined {
  if (!isDateOnly(checkIn) || !isDateOnly(checkOut)) return 'invalid_date'
  const nights = nightsBetween(checkIn, checkOut)
  if (nights <= 0) return 'not_positive'
  if (nights > MAX_STAY_NIGHTS) return 'too_long'
  return undefined
}

export function isWeekendNight(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay()
  return day === 5 || day === 6
}
