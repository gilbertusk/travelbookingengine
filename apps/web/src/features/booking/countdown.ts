/**
 * Hitung mundur hold (FR-15), sebagai fungsi murni.
 *
 * Yang dihitung mundur adalah `heldUntil` dari booking-service, menurut JAM
 * booking-service. Jam komputer pengguna bisa meleset beberapa menit; hold
 * yang tampak habis padahal masih ada waktu — atau sebaliknya, tampak masih
 * ada padahal sudah dilepas — adalah dua cara kehilangan pemesanan yang
 * sebenarnya bisa diselesaikan. Selisihnya dihitung SEKALI dari `serverTime`
 * jawaban pertama (lihat [clockOffset]) dan dipakai sampai hold selesai.
 */

/** Di bawah ini hitung mundur memakai nada peringatan — DESIGN-SYSTEM.md bagian 6. */
export const WARNING_BELOW_MS = 5 * 60_000

/**
 * Ambang yang diumumkan pembaca layar. Mengumumkan setiap detik membuat
 * pembaca layar tidak dapat membacakan apa pun yang lain di halaman.
 */
export const ANNOUNCE_AT_MS = [10 * 60_000, 5 * 60_000, 2 * 60_000, 60_000, 30_000] as const

export type CountdownTone = 'neutral' | 'warning' | 'expired'

export interface CountdownState {
  readonly remainingMs: number
  readonly tone: CountdownTone
  /** `mm:ss`, dibulatkan ke atas: 0:00 hanya tampil ketika benar-benar habis. */
  readonly clock: string
}

/**
 * Selisih jam server dan jam lokal, dalam milidetik.
 *
 * Jam server dibandingkan dengan TITIK TENGAH permintaan, bukan saat jawaban
 * tiba: `serverTime` dibentuk di antara keduanya. Pada koneksi lambat, memakai
 * saat tiba saja menggeser hitung mundur sebanyak separuh waktu perjalanannya.
 */
export function clockOffset(serverTime: string, sentAt: number, receivedAt: number): number {
  const server = Date.parse(serverTime)
  if (Number.isNaN(server)) return 0

  return server - (sentAt + receivedAt) / 2
}

export function countdown(heldUntil: string, localNow: number, offsetMs: number): CountdownState {
  const remainingMs = Math.max(0, Date.parse(heldUntil) - (localNow + offsetMs))
  const tone: CountdownTone =
    remainingMs === 0 ? 'expired' : remainingMs < WARNING_BELOW_MS ? 'warning' : 'neutral'

  return { remainingMs, tone, clock: formatClock(remainingMs) }
}

export function formatClock(remainingMs: number): string {
  const totalSeconds = Math.ceil(remainingMs / 1_000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  return `${String(minutes)}:${String(seconds).padStart(2, '0')}`
}

/**
 * Ambang yang baru saja DILEWATI di antara dua pembacaan, bila ada.
 *
 * Dihitung dari dua pembacaan, bukan dari kesamaan dengan ambang: tab yang
 * tertidur di latar belakang melompati detik, dan detik 5:00 tepat mungkin tidak
 * pernah terbaca.
 */
export function crossedThreshold(previousMs: number, currentMs: number): number | undefined {
  return ANNOUNCE_AT_MS.find((threshold) => previousMs > threshold && currentMs <= threshold)
}

/** Kalimat untuk pembaca layar. */
export function announcement(thresholdMs: number): string {
  const minutes = Math.round(thresholdMs / 60_000)
  if (thresholdMs < 60_000) return `Sisa waktu ${String(Math.round(thresholdMs / 1_000))} detik.`

  return `Sisa waktu ${String(minutes)} menit.`
}
