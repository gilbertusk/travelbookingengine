import { down, halfAwayFromZero, halfEven, halfUp, up } from 'dinero.js'

/**
 * Mode pembulatan.
 *
 * Selalu dinyatakan eksplisit sebagai argumen. Tidak ada bawaan tersembunyi —
 * pembulatan yang tidak disebut adalah pembulatan yang tidak pernah
 * didiskusikan, dan arah pembulatan yang salah pada ratusan ribu transaksi
 * adalah selisih yang nyata.
 */
export const ROUNDING_MODES = ['half_even', 'half_up', 'half_away_from_zero', 'up', 'down'] as const
export type RoundingMode = (typeof ROUNDING_MODES)[number]

/**
 * Tipe transformer diambil dari salah satu transformer bawaan dinero.
 *
 * `DineroTransformer` menuntut tiga parameter tipe yang seluruhnya merupakan
 * detail internal pustakanya; menuliskannya di sini berarti menyalin detail
 * yang dapat berubah pada rilis berikutnya.
 */
type Transformer = typeof halfEven

const TRANSFORMERS: Readonly<Record<RoundingMode, Transformer>> = {
  /**
   * Bankers' rounding. Pilihan bawaan untuk perhitungan keuangan karena tidak
   * berat sebelah: `half_up` membulatkan setiap nilai tengah ke atas, dan pada
   * jutaan transaksi bias itu menumpuk menjadi selisih yang terukur.
   */
  half_even: halfEven,
  half_up: halfUp,
  half_away_from_zero: halfAwayFromZero,
  /** Ke atas selalu — dipakai ketika kita tidak boleh menagih kurang. */
  up,
  /** Ke bawah selalu — dipakai untuk pengembalian dana. */
  down,
}

export function transformerFor(mode: RoundingMode): Transformer {
  return TRANSFORMERS[mode]
}

/**
 * Pembulatan yang dipakai untuk harga jual.
 *
 * Disebut namanya, bukan dijadikan nilai bawaan pada fungsi, supaya setiap
 * pemanggil tetap harus menuliskannya dan setiap pembaca melihatnya.
 */
export const PRICE_ROUNDING: RoundingMode = 'half_even'
