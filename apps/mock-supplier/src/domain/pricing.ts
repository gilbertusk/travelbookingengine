import type { RatePlan } from './catalog.js'
import { fractionOf } from './deterministic.js'
import { isWeekendNight } from './stay.js'

/**
 * Harga dalam satuan terkecil IDR. Konversi ke mata uang supplier terjadi di
 * lapisan HTTP — supplier menjual dalam mata uangnya sendiri, katalog tidak.
 */

const WEEKEND_UPLIFT = 1.18
const SEASONAL_SWING = 0.12

export function nightlyPriceMinorIdr(ratePlan: RatePlan, date: string): number {
  const weekend = isWeekendNight(date) ? WEEKEND_UPLIFT : 1
  // Ayunan musiman kecil agar harga antar tanggal tidak seragam, tetapi tetap
  // sama setiap kali ditanyakan untuk tanggal yang sama.
  const seasonal = 1 + (fractionOf('season', ratePlan.id, date) - 0.5) * SEASONAL_SWING * 2

  return Math.round((ratePlan.basePriceMinorIdr * weekend * seasonal) / 100) * 100
}

export function stayTotalMinorIdr(ratePlan: RatePlan, nights: readonly string[]): number {
  return nights.reduce((total, date) => total + nightlyPriceMinorIdr(ratePlan, date), 0)
}

/**
 * Pergeseran harga saat price check.
 *
 * Inilah kondisi yang membuat FR-14 punya alasan: harga yang dilihat pengguna
 * saat mencari bisa berbeda dari harga sebenarnya saat ia membayar. Besarnya
 * ditentukan dari kunci pergeseran, sehingga pergeseran yang sama dapat
 * diulang dalam pengujian.
 */
export function driftedPriceMinorIdr(originalMinor: number, driftKey: string): number {
  const magnitude = 0.03 + fractionOf('driftSize', driftKey) * 0.09
  const direction = fractionOf('driftDir', driftKey) < 0.65 ? 1 : -1

  return Math.round((originalMinor * (1 + magnitude * direction)) / 100) * 100
}
