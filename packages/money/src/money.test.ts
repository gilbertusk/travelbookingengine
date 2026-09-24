import { describe, expect, test } from 'vitest'
import { EXPONENT } from './currency.js'
import { toDecimalString } from './format.js'
import {
  add,
  allocate,
  compare,
  convert,
  equals,
  isNegative,
  isZero,
  money,
  multiply,
  negate,
  round,
  subtract,
  sum,
  toPrecise,
  zero,
} from './money.js'

/**
 * Uang.
 *
 * NFR-08 melarang aritmetika pecahan biner untuk nilai uang. Berkas ini yang
 * membuktikannya — dan pengujian pertama di bawah menjelaskan keputusan
 * desainnya lebih cepat daripada paragraf mana pun.
 */

const rupiah = (amount: number) => money(amount, 'IDR')
const dollar = (amount: number) => money(amount, 'USD')

describe('kenapa uang tidak boleh bertipe number', () => {
  test('menjumlahkan sepuluh sen seratus kali menghasilkan tepat sepuluh dolar', () => {
    // Dengan `number`, 0.1 dijumlahkan seratus kali menghasilkan
    // 9.99999999999998 — bukan 10. Pecahan biner tidak dapat mewakili 0,1,
    // dan galatnya menumpuk pada setiap penjumlahan.
    let naive = 0
    for (let index = 0; index < 100; index += 1) naive += 0.1
    expect(naive).not.toBe(10)

    // Dengan satuan terkecil sebagai bilangan bulat, tidak ada yang menumpuk.
    let total = zero('USD')
    for (let index = 0; index < 100; index += 1) total = add(total, dollar(10))

    expect(total.amountMinor).toBe(1_000)
    expect(toDecimalString(total)).toBe('10.00')
  })

  test('seribu penjumlahan pun tetap tepat', () => {
    let total = zero('IDR')
    for (let index = 0; index < 1_000; index += 1) total = add(total, rupiah(1_337))

    expect(total.amountMinor).toBe(1_337_000)
  })

  test('menolak jumlah yang bukan bilangan bulat', () => {
    // Nilai pecahan yang masuk berarti seseorang mengira satuannya rupiah
    // penuh padahal yang diminta satuan terkecil — atau sebaliknya.
    expect(() => money(267.83, 'USD')).toThrow(RangeError)
    expect(() => money(Number.NaN, 'IDR')).toThrow(RangeError)
    expect(() => money(Number.MAX_SAFE_INTEGER + 2, 'IDR')).toThrow(RangeError)
  })
})

describe('operasi dasar', () => {
  test('menjumlahkan dan mengurangi', () => {
    expect(add(rupiah(500_000), rupiah(250_000)).amountMinor).toBe(750_000)
    expect(subtract(rupiah(500_000), rupiah(250_000)).amountMinor).toBe(250_000)
  })

  test('hasil selalu membawa mata uangnya', () => {
    expect(add(rupiah(1), rupiah(2)).currency).toBe('IDR')
    expect(subtract(dollar(1), dollar(2)).currency).toBe('USD')
  })

  test('membandingkan', () => {
    expect(compare(rupiah(100), rupiah(200))).toBe(-1)
    expect(compare(rupiah(200), rupiah(100))).toBe(1)
    expect(compare(rupiah(100), rupiah(100))).toBe(0)
    expect(equals(rupiah(100), rupiah(100))).toBe(true)
  })

  test('mengenali nol dan negatif', () => {
    expect(isZero(zero('IDR'))).toBe(true)
    expect(isZero(rupiah(1))).toBe(false)
    expect(isNegative(rupiah(-1))).toBe(true)
    expect(isNegative(rupiah(1))).toBe(false)
    expect(negate(rupiah(500)).amountMinor).toBe(-500)
  })

  test('menjumlahkan daftar', () => {
    expect(sum([rupiah(100), rupiah(200), rupiah(300)], 'IDR').amountMinor).toBe(600)
    expect(sum([], 'IDR').amountMinor).toBe(0)
  })
})

describe('operasi lintas mata uang ditolak', () => {
  test('menolak saat berjalan ketika tipenya terlalu lebar', () => {
    // Tipe menolak `add(rupiah, dolar)` saat kompilasi. Nilai yang datang dari
    // JSON atau basis data bertipe Money<Currency> — lebar — dan di sanalah
    // pemeriksaan saat jalan ini bekerja.
    const fromJson = rupiah(1_000) as ReturnType<typeof money>
    const other = dollar(100) as ReturnType<typeof money>

    expect(() => add(fromJson, other)).toThrow(TypeError)
    expect(() => subtract(fromJson, other)).toThrow(TypeError)
    expect(() => compare(fromJson, other)).toThrow(TypeError)
  })

  test('pesan galatnya menyebut kedua mata uang dan jalan keluarnya', () => {
    const fromJson = rupiah(1_000) as ReturnType<typeof money>
    const other = dollar(100) as ReturnType<typeof money>

    expect(() => add(fromJson, other)).toThrow(/IDR.*USD|USD.*IDR/)
    expect(() => add(fromJson, other)).toThrow(/convert/)
  })
})

describe('pembagian tanpa kehilangan satuan terkecil', () => {
  test('membagi sepuluh rupiah menjadi tiga tidak kehilangan satu rupiah pun', () => {
    const parts = allocate(rupiah(10), [1, 1, 1])

    expect(parts.map((part) => part.amountMinor)).toEqual([4, 3, 3])
    expect(sum(parts, 'IDR').amountMinor).toBe(10)
  })

  test('jumlah seluruh bagian selalu sama dengan asalnya', () => {
    for (const amount of [1, 7, 99, 100_003, 1_234_567]) {
      for (const ratios of [
        [1, 1],
        [1, 1, 1],
        [2, 3, 5],
        [1, 1, 1, 1, 1, 1, 1],
      ]) {
        const parts = allocate(rupiah(amount), ratios)
        expect(sum(parts, 'IDR').amountMinor).toBe(amount)
      }
    }
  })

  test('membagi menurut rasio yang tidak sama', () => {
    const parts = allocate(dollar(10_000), [70, 30])

    expect(parts.map((part) => part.amountMinor)).toEqual([7_000, 3_000])
  })

  test('menolak rasio yang tidak masuk akal', () => {
    expect(() => allocate(rupiah(100), [])).toThrow(RangeError)
    expect(() => allocate(rupiah(100), [-1, 2])).toThrow(RangeError)
    expect(() => allocate(rupiah(100), [0, 0])).toThrow(RangeError)
  })
})

describe('perkalian dan pembulatan', () => {
  test('perkalian belum membulatkan', () => {
    // Markup dan pajak dikalikan berurutan; membulatkan di antaranya
    // menghasilkan angka yang berbeda dari perhitungan yang benar.
    const result = multiply(dollar(26_783), { amount: 125, scale: 3 })

    expect(result.scale).toBeGreaterThan(0)
  })

  test('pembulatan wajib disebut dan hanya terjadi sekali', () => {
    const precise = multiply(dollar(26_783), { amount: 125, scale: 3 })

    expect(round(precise, 'half_even').amountMinor).toBe(3_348)
    expect(round(precise, 'down').amountMinor).toBe(3_347)
    expect(round(precise, 'up').amountMinor).toBe(3_348)
  })

  test('membulatkan sekali di akhir berbeda dari membulatkan di setiap langkah', () => {
    // Inilah alasan PreciseMoney ada. Dua markup 10% berturut-turut atas
    // Rp 1.005: sekali di akhir menghasilkan 1216, dibulatkan dua kali
    // menghasilkan 1217 — dan selisih itu tidak dapat dijelaskan kepada
    // siapa pun yang membandingkan tagihan.
    const base = rupiah(1_005)
    const factor = { amount: 11, scale: 1 }

    const onceAtEnd = round(multiply(multiply(base, factor), factor), 'half_even')

    const roundedTwice = round(
      multiply(round(multiply(base, factor), 'half_even'), factor),
      'half_even',
    )

    expect(onceAtEnd.amountMinor).toBe(1_216)
    expect(roundedTwice.amountMinor).toBe(1_217)
    expect(onceAtEnd.amountMinor).not.toBe(roundedTwice.amountMinor)
  })

  test('bankers rounding tidak berat sebelah', () => {
    // half_up membulatkan setiap nilai tengah ke atas, dan pada jutaan
    // transaksi bias itu menumpuk menjadi selisih yang terukur.
    const half = (amountMinor: number) => ({ amountMinor, currency: 'IDR' as const, scale: 1 })

    expect(round(half(25), 'half_even').amountMinor).toBe(2)
    expect(round(half(35), 'half_even').amountMinor).toBe(4)
    expect(round(half(25), 'half_up').amountMinor).toBe(3)
    expect(round(half(35), 'half_up').amountMinor).toBe(4)
  })

  test('nilai yang sudah pada skala kanonik tidak berubah saat dibulatkan', () => {
    expect(round(toPrecise(rupiah(1_337)), 'half_even').amountMinor).toBe(1_337)
  })
})

describe('pembulatan berbeda antara IDR dan USD', () => {
  test('IDR dibulatkan ke rupiah penuh, USD ke sen', () => {
    // IDR memakai eksponen 0 dan USD eksponen 2; keduanya sengaja diuji
    // terpisah karena inilah tempat asumsi "semua mata uang dua desimal"
    // biasanya menyelinap masuk.
    expect(EXPONENT.IDR).toBe(0)
    expect(EXPONENT.USD).toBe(2)

    const idr = { amountMinor: 1_004_9, currency: 'IDR' as const, scale: 1 }
    const usd = { amountMinor: 1_004_9, currency: 'USD' as const, scale: 1 }

    expect(round(idr, 'half_even').amountMinor).toBe(1_005)
    expect(round(usd, 'half_even').amountMinor).toBe(1_005)
    expect(toDecimalString(round(idr, 'half_even'))).toBe('1005')
    expect(toDecimalString(round(usd, 'half_even'))).toBe('10.05')
  })

  test('satu rupiah adalah satuan terkecil rupiah', () => {
    expect(toDecimalString(rupiah(2_893_400))).toBe('2893400')
  })
})

describe('konversi mata uang', () => {
  test('mengubah dolar menjadi rupiah dengan kurs yang diberikan', () => {
    // 267,83 USD × 16.000 = 4.285.280 IDR
    const converted = round(
      convert(dollar(26_783), 'IDR', { amount: 16_000, scale: 0 }),
      'half_even',
    )

    expect(converted.currency).toBe('IDR')
    expect(converted.amountMinor).toBe(4_285_280)
  })

  test('kurs berpecahan tetap tepat', () => {
    // 1 USD = 16.235,75 IDR
    const converted = round(
      convert(dollar(10_000), 'IDR', { amount: 1_623_575, scale: 2 }),
      'half_even',
    )

    expect(converted.amountMinor).toBe(1_623_575)
  })

  test('konversi belum membulatkan, supaya dapat berada di tengah rantai', () => {
    const precise = convert(dollar(1), 'IDR', { amount: 16_000, scale: 0 })

    expect(precise.currency).toBe('IDR')
    expect(round(precise, 'half_even').amountMinor).toBe(160)
  })

  test('mengubah rupiah menjadi dolar', () => {
    // 1 IDR = 0,0000625 USD
    const converted = round(
      convert(rupiah(4_285_280), 'USD', { amount: 625, scale: 7 }),
      'half_even',
    )

    expect(converted.currency).toBe('USD')
    expect(converted.amountMinor).toBe(26_783)
  })

  test('bolak-balik pada kurs yang sama kembali ke nilai semula', () => {
    const start = dollar(26_783)
    const toIdr = round(convert(start, 'IDR', { amount: 16_000, scale: 0 }), 'half_even')
    const back = round(convert(toIdr, 'USD', { amount: 625, scale: 7 }), 'half_even')

    expect(back.amountMinor).toBe(start.amountMinor)
  })
})
