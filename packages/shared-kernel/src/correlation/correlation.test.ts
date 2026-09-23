import { describe, expect, test } from 'vitest'
import {
  getCorrelationId,
  getOrCreateCorrelationId,
  newCorrelationId,
  runWithCorrelation,
} from './correlation.js'

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('correlation', () => {
  test('newCorrelationId menghasilkan UUID v7 yang terurut menurut waktu', async () => {
    const pertama = newCorrelationId()
    await delay(2)
    const kedua = newCorrelationId()

    expect(pertama).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    // Urutan leksikografis mengikuti urutan waktu — inilah alasan memilih v7
    expect(kedua > pertama).toBe(true)
  })

  test('getCorrelationId mengembalikan undefined di luar konteks', () => {
    expect(getCorrelationId()).toBeUndefined()
  })

  test('correlationId terbaca di dalam konteks', () => {
    runWithCorrelation('abc-123', () => {
      expect(getCorrelationId()).toBe('abc-123')
    })
  })

  test('konteks mengikuti alur asinkron tanpa diteruskan sebagai argumen', async () => {
    // Arrange — meniru rantai pemanggilan berlapis yang tidak tahu soal correlation
    const lapisanDalam = async (): Promise<string | undefined> => {
      await delay(5)
      return getCorrelationId()
    }
    const lapisanTengah = async (): Promise<string | undefined> => lapisanDalam()

    // Act
    const hasil = await runWithCorrelation('req-async', async () => lapisanTengah())

    // Assert
    expect(hasil).toBe('req-async')
  })

  test('konteks bersarang tidak saling mencemari', async () => {
    const jalankan = async (id: string): Promise<string | undefined> =>
      runWithCorrelation(id, async () => {
        await delay(Math.random() * 10)
        return getCorrelationId()
      })

    const hasil = await Promise.all([jalankan('a'), jalankan('b'), jalankan('c')])

    expect(hasil).toEqual(['a', 'b', 'c'])
  })

  test('konteks berakhir setelah fungsinya selesai', () => {
    runWithCorrelation('sementara', () => {
      expect(getCorrelationId()).toBe('sementara')
    })

    expect(getCorrelationId()).toBeUndefined()
  })

  test('getOrCreateCorrelationId memakai yang ada bila berada dalam konteks', () => {
    runWithCorrelation('sudah-ada', () => {
      expect(getOrCreateCorrelationId()).toBe('sudah-ada')
    })
  })

  test('getOrCreateCorrelationId membuat baru bila di luar konteks', () => {
    const id = getOrCreateCorrelationId()

    expect(id).toMatch(/^[0-9a-f]{8}-/)
  })
})
