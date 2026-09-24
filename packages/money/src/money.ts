import {
  add as dineroAdd,
  allocate as dineroAllocate,
  compare as dineroCompare,
  convert as dineroConvert,
  dinero,
  isNegative as dineroIsNegative,
  isZero as dineroIsZero,
  multiply as dineroMultiply,
  subtract as dineroSubtract,
  toSnapshot,
  transformScale,
  type Dinero,
} from 'dinero.js'
import { DINERO_CURRENCY, EXPONENT, type Currency } from './currency.js'
import { transformerFor, type RoundingMode } from './rounding.js'

/**
 * Uang.
 *
 * Selalu membawa mata uangnya, selalu dalam satuan terkecil, selalu bilangan
 * bulat. Tidak ada cara menuliskan nilai uang tanpa mata uang — bentuknya
 * sendiri yang mencegahnya, bukan kesepakatan.
 *
 * Bergeneral atas mata uangnya supaya operasi lintas mata uang ditolak
 * **compiler**, bukan hanya saat berjalan. Lihat [add].
 */
export interface Money<C extends Currency = Currency> {
  /** Untuk IDR berarti rupiah, untuk USD berarti sen. Selalu bilangan bulat. */
  readonly amountMinor: number
  readonly currency: C
}

/**
 * Nilai antara yang belum dibulatkan.
 *
 * CONVENTIONS.md bagian 9: pembulatan dilakukan **sekali di akhir**. Rantai
 * harga supplier → konversi → markup → pajak yang membulatkan di setiap
 * langkah akan meleset beberapa satuan dari hasil yang benar, dan selisihnya
 * tidak dapat dijelaskan kepada siapa pun.
 *
 * Tipe ini membawa skala tambahan sepanjang rantai itu. Ia tidak dapat
 * disimpan maupun dikirim — satu-satunya jalan keluarnya adalah [round].
 */
export interface PreciseMoney<C extends Currency = Currency> {
  readonly amountMinor: number
  readonly currency: C
  /** Banyak angka desimal tambahan di luar eksponen mata uangnya. */
  readonly scale: number
}

/** Pengali berskala, mis. 12,5% ditulis `{ amount: 125, scale: 3 }`. */
export interface ScaledFactor {
  readonly amount: number
  readonly scale: number
}

export function money<C extends Currency>(amountMinor: number, currency: C): Money<C> {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new RangeError(
      `jumlah uang harus bilangan bulat dalam satuan terkecil, diterima ${String(amountMinor)}`,
    )
  }

  return { amountMinor, currency }
}

export function zero<C extends Currency>(currency: C): Money<C> {
  return { amountMinor: 0, currency }
}

function toDinero<C extends Currency>(value: Money<C> | PreciseMoney<C>): Dinero<number> {
  const scale = 'scale' in value ? EXPONENT[value.currency] + value.scale : EXPONENT[value.currency]

  return dinero({ amount: value.amountMinor, currency: DINERO_CURRENCY[value.currency], scale })
}

function fromDinero<C extends Currency>(value: Dinero<number>, currency: C): PreciseMoney<C> {
  const snapshot = toSnapshot(value)

  return {
    amountMinor: snapshot.amount,
    currency,
    scale: snapshot.scale - EXPONENT[currency],
  }
}

export function toPrecise<C extends Currency>(value: Money<C>): PreciseMoney<C> {
  return { amountMinor: value.amountMinor, currency: value.currency, scale: 0 }
}

/**
 * Satu-satunya jalan dari nilai antara menjadi uang yang dapat disimpan.
 *
 * Mode pembulatan wajib disebut. Tidak ada nilai bawaan, karena arah
 * pembulatan adalah keputusan bisnis — bukan detail teknis yang boleh
 * diputuskan pustaka.
 */
export function round<C extends Currency>(
  value: PreciseMoney<C>,
  rounding: RoundingMode,
): Money<C> {
  if (value.scale === 0) return money(value.amountMinor, value.currency)

  const transformed = transformScale(
    toDinero(value),
    EXPONENT[value.currency],
    transformerFor(rounding),
  )

  return money(toSnapshot(transformed).amount, value.currency)
}

/**
 * Penjumlahan.
 *
 * `NoInfer` pada argumen kedua membuat mata uang disimpulkan HANYA dari
 * argumen pertama. Akibatnya `add(rupiah, dolar)` gagal dikompilasi, bukan
 * gagal saat berjalan — dan kegagalan saat berjalan untuk hal seperti ini
 * berarti ia sudah sampai ke produksi.
 */
export function add<C extends Currency>(a: Money<C>, b: Money<NoInfer<C>>): Money<C> {
  assertSameCurrency(a, b)

  return money(toSnapshot(dineroAdd(toDinero(a), toDinero(b))).amount, a.currency)
}

export function subtract<C extends Currency>(a: Money<C>, b: Money<NoInfer<C>>): Money<C> {
  assertSameCurrency(a, b)

  return money(toSnapshot(dineroSubtract(toDinero(a), toDinero(b))).amount, a.currency)
}

/**
 * Perkalian dengan faktor berskala.
 *
 * Hasilnya BELUM dibulatkan — itu disengaja. Markup dan pajak dikalikan
 * berurutan, dan membulatkan di antara keduanya menghasilkan angka yang
 * berbeda dari perhitungan yang benar.
 */
export function multiply<C extends Currency>(
  value: Money<C> | PreciseMoney<C>,
  factor: ScaledFactor,
): PreciseMoney<C> {
  return fromDinero(dineroMultiply(toDinero(value), factor), value.currency)
}

/**
 * Membagi menjadi beberapa bagian menurut rasio, tanpa kehilangan satu satuan
 * terkecil pun.
 *
 * Sisa pembagian dibagikan ke bagian-bagian awal, bukan dibuang. Membagi
 * Rp 10 menjadi tiga menghasilkan 4, 3, 3 — bukan 3, 3, 3 yang kehilangan
 * satu rupiah, dan bukan 3.33 yang bukan uang.
 */
export function allocate<C extends Currency>(
  value: Money<C>,
  ratios: readonly number[],
): readonly Money<C>[] {
  if (ratios.length === 0) throw new RangeError('allocate membutuhkan minimal satu rasio')
  if (ratios.some((ratio) => ratio < 0)) throw new RangeError('rasio tidak boleh negatif')
  if (ratios.every((ratio) => ratio === 0)) throw new RangeError('rasio tidak boleh semuanya nol')

  return dineroAllocate(toDinero(value), [...ratios]).map((part) =>
    money(toSnapshot(part).amount, value.currency),
  )
}

/**
 * Konversi mata uang.
 *
 * `rate` dinyatakan dalam satuan UTAMA per satuan utama — 1 USD = 16.000 IDR
 * ditulis `{ amount: 16000, scale: 0 }`. Menyatakannya dalam satuan terkecil
 * akan membuat angkanya bergantung pada eksponen kedua mata uang, dan siapa
 * pun yang mengisi tabel kurs harus mengingat keduanya.
 *
 * Hasilnya belum dibulatkan, supaya konversi dapat berada di tengah rantai
 * perhitungan tanpa menambah pembulatan sendiri.
 */
export function convert<From extends Currency, To extends Currency>(
  value: Money<From> | PreciseMoney<From>,
  to: To,
  rate: ScaledFactor,
): PreciseMoney<To> {
  const converted = dineroConvert(toDinero(value), DINERO_CURRENCY[to], {
    [to]: { amount: rate.amount, scale: rate.scale },
  })

  return fromDinero(converted, to)
}

/**
 * Penjumlahan nilai antara.
 *
 * Skala keduanya boleh berbeda — dinero menyamakannya lebih dulu tanpa
 * kehilangan presisi. Inilah yang membuat rantai konversi → markup → pajak
 * dapat berjalan tanpa satu pun pembulatan di tengah.
 */
export function addPrecise<C extends Currency>(
  a: PreciseMoney<C>,
  b: PreciseMoney<NoInfer<C>>,
): PreciseMoney<C> {
  assertSameCurrency(a, b)

  return fromDinero(dineroAdd(toDinero(a), toDinero(b)), a.currency)
}

export function subtractPrecise<C extends Currency>(
  a: PreciseMoney<C>,
  b: PreciseMoney<NoInfer<C>>,
): PreciseMoney<C> {
  assertSameCurrency(a, b)

  return fromDinero(dineroSubtract(toDinero(a), toDinero(b)), a.currency)
}

export function compare<C extends Currency>(a: Money<C>, b: Money<NoInfer<C>>): -1 | 0 | 1 {
  assertSameCurrency(a, b)

  return dineroCompare(toDinero(a), toDinero(b))
}

export function equals<C extends Currency>(a: Money<C>, b: Money<NoInfer<C>>): boolean {
  return compare(a, b) === 0
}

export function isZero(value: Money): boolean {
  return dineroIsZero(toDinero(value))
}

export function isNegative(value: Money): boolean {
  return dineroIsNegative(toDinero(value))
}

export function negate<C extends Currency>(value: Money<C>): Money<C> {
  return money(-value.amountMinor, value.currency)
}

export function sum<C extends Currency>(values: readonly Money<C>[], currency: C): Money<C> {
  return values.reduce<Money<C>>((total, value) => add(total, value), zero(currency))
}

/**
 * Penjaga saat tipe tidak cukup.
 *
 * Tipe menolak `add(rupiah, dolar)` ketika keduanya diketahui pada saat
 * kompilasi. Nilai yang datang dari JSON atau basis data bertipe
 * `Money<Currency>` — lebar — dan di sanalah pemeriksaan ini bekerja.
 */
function assertSameCurrency(a: Money | PreciseMoney, b: Money | PreciseMoney): void {
  if (a.currency !== b.currency) {
    throw new TypeError(
      `operasi lintas mata uang ditolak: ${a.currency} dan ${b.currency}. ` +
        'Konversikan lebih dulu dengan convert().',
    )
  }
}
