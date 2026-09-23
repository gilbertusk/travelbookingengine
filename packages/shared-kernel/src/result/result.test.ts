import { describe, expect, test } from 'vitest'
import { andThen, err, isErr, isOk, map, mapErr, ok, partition, unwrapOr } from './result.js'

describe('result', () => {
  test('ok membawa nilai dan menandai keberhasilan', () => {
    const result = ok(42)

    expect(result.ok).toBe(true)
    expect(result.value).toBe(42)
  })

  test('err membawa galat dan menandai kegagalan', () => {
    const result = err('gagal')

    expect(result.ok).toBe(false)
    expect(result.error).toBe('gagal')
  })

  test('isOk mempersempit tipe ke Ok', () => {
    const result = ok('nilai') as ReturnType<typeof ok<string>> | ReturnType<typeof err<number>>

    if (isOk(result)) {
      expect(result.value.toUpperCase()).toBe('NILAI')
    } else {
      throw new Error('seharusnya ok')
    }
  })

  test('isErr mempersempit tipe ke Err', () => {
    const result = err(404) as ReturnType<typeof ok<string>> | ReturnType<typeof err<number>>

    if (isErr(result)) {
      expect(result.error.toFixed(0)).toBe('404')
    } else {
      throw new Error('seharusnya err')
    }
  })

  test('map mengubah nilai ketika berhasil', () => {
    expect(map(ok(2), (n) => n * 3)).toEqual(ok(6))
  })

  test('map tidak memanggil fungsi ketika gagal', () => {
    let dipanggil = false

    const result = map(err<string>('rusak'), () => {
      dipanggil = true
      return 1
    })

    expect(dipanggil).toBe(false)
    expect(result).toEqual(err('rusak'))
  })

  test('mapErr mengubah galat ketika gagal', () => {
    expect(mapErr(err('rusak'), (e) => e.length)).toEqual(err(5))
  })

  test('mapErr tidak mengubah nilai ketika berhasil', () => {
    expect(mapErr(ok(1), () => 'lain')).toEqual(ok(1))
  })

  test('andThen merangkai operasi yang juga mengembalikan Result', () => {
    const bagi = (n: number): ReturnType<typeof ok<number>> | ReturnType<typeof err<string>> =>
      n === 0 ? err('pembagian nol') : ok(100 / n)

    expect(andThen(ok(4), bagi)).toEqual(ok(25))
    expect(andThen(ok(0), bagi)).toEqual(err('pembagian nol'))
    expect(andThen(err<string>('sudah gagal'), bagi)).toEqual(err('sudah gagal'))
  })

  test('unwrapOr mengembalikan nilai cadangan ketika gagal', () => {
    expect(unwrapOr(ok(1), 99)).toBe(1)
    expect(unwrapOr(err<string>('rusak') as never, 99)).toBe(99)
  })

  test('partition memisahkan hasil berhasil dan gagal sambil mempertahankan keduanya', () => {
    // Arrange — meniru fan-out supplier: sebagian menjawab, sebagian gagal
    const results = [ok('SKY'), err('LUNA timeout'), ok('NOVA'), err('ZEPH 503')]

    // Act
    const { values, errors } = partition(results)

    // Assert
    expect(values).toEqual(['SKY', 'NOVA'])
    expect(errors).toEqual(['LUNA timeout', 'ZEPH 503'])
  })

  test('partition mengembalikan dua array kosong untuk masukan kosong', () => {
    expect(partition([])).toEqual({ values: [], errors: [] })
  })
})
