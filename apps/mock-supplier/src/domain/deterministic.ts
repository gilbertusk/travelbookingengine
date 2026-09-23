/**
 * Keacakan yang dapat diulang.
 *
 * Seluruh data supplier tiruan diturunkan dari fungsi-fungsi di sini, bukan
 * dari Math.random. Alasannya penting: uji beban pada Step 15 dan Step 22
 * membandingkan hasil antar proses, dan katalog yang berubah setiap restart
 * membuat perbandingan itu tidak berarti. Ketersediaan kamar untuk tanggal
 * tertentu juga harus sama di setiap proses, kalau tidak pengujian oversell
 * tidak dapat diulang.
 */

const FNV_OFFSET_BASIS = 2_166_136_261
const FNV_PRIME = 16_777_619

export function hashString(value: string): number {
  let hash = FNV_OFFSET_BASIS

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, FNV_PRIME)
  }

  return hash >>> 0
}

/**
 * Mengembalikan pecahan 0..1 yang selalu sama untuk kunci yang sama.
 */
export function fractionOf(...parts: readonly string[]): number {
  return hashString(parts.join('|')) / 0x1_00_00_00_00
}

/**
 * Bilangan bulat dalam rentang inklusif, ditentukan sepenuhnya oleh kunci.
 */
export function intBetween(min: number, max: number, ...parts: readonly string[]): number {
  return min + Math.floor(fractionOf(...parts) * (max - min + 1))
}

export function pickOne<T>(items: readonly T[], ...parts: readonly string[]): T {
  const item = items[intBetween(0, items.length - 1, ...parts)]

  if (item === undefined) {
    throw new Error('pickOne dipanggil dengan daftar kosong')
  }

  return item
}

export function pickSome<T>(items: readonly T[], count: number, ...parts: readonly string[]): T[] {
  return items
    .map((item, index) => ({ item, order: fractionOf(...parts, String(index)) }))
    .sort((a, b) => a.order - b.order)
    .slice(0, count)
    .map((entry) => entry.item)
}

/**
 * Keputusan ya/tidak dengan peluang tertentu, tetap untuk kunci yang sama.
 */
export function chance(probability: number, ...parts: readonly string[]): boolean {
  return fractionOf(...parts) < probability
}
