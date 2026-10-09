import { fractionOf } from './deterministic.js'

/**
 * Ketersediaan dasar per rate plan per malam.
 *
 * Dihitung dari fungsi, bukan disimpan. Menyimpan ketersediaan untuk setiap
 * rate plan pada setiap tanggal selama setahun berarti ratusan ribu baris di
 * memori tanpa memberi apa pun yang tidak diberikan fungsi deterministik.
 * Yang disimpan hanya selisihnya: unit yang sedang ditahan atau sudah terjual.
 */

export const MAX_UNITS_PER_NIGHT = 8
const SOLD_OUT_PROBABILITY = 0.07

export function baseAvailability(ratePlanId: string, date: string): number {
  const roll = fractionOf('avail', ratePlanId, date)

  if (roll < SOLD_OUT_PROBABILITY) return 0

  // Sisanya condong ke 2–6 unit; sangat sedikit malam yang punya stok penuh,
  // sehingga pengujian oversell pada Step 22 punya kondisi rebutan yang nyata.
  const scaled = (roll - SOLD_OUT_PROBABILITY) / (1 - SOLD_OUT_PROBABILITY)
  return 1 + Math.floor(scaled * MAX_UNITS_PER_NIGHT)
}

/**
 * Ketersediaan sebenarnya untuk satu malam setelah dikurangi unit yang sedang
 * ditahan dan yang sudah terjual.
 */
export function remainingUnits(
  ratePlanId: string,
  date: string,
  consumed: number,
  base: number = baseAvailability(ratePlanId, date),
): number {
  return Math.max(base - consumed, 0)
}

/**
 * Ketersediaan untuk seluruh rentang menginap adalah yang terkecil di antara
 * malam-malamnya. Satu malam yang habis membuat seluruh rentang tidak dapat
 * dipesan, dan ini kesalahan yang mudah terjadi bila hanya memeriksa malam
 * pertama.
 */
export function availableForStay(
  nights: readonly string[],
  unitsFor: (date: string) => number,
): number {
  if (nights.length === 0) return 0

  return nights.reduce(
    (smallest, date) => Math.min(smallest, unitsFor(date)),
    Number.MAX_SAFE_INTEGER,
  )
}
