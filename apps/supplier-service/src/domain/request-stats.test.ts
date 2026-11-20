import { describe, expect, test } from 'vitest'
import { percentile, summarizeRequests, type RequestSample } from './request-stats.js'

const ok = (latencyMs: number): RequestSample => ({ outcome: 'success', latencyMs })
const gagal = (latencyMs: number): RequestSample => ({ outcome: 'failure', latencyMs })

describe('summarizeRequests', () => {
  test('tanpa sampel: nol percobaan, latensi null — bukan 0 ms', () => {
    expect(summarizeRequests([])).toEqual({
      attempts: 0,
      failures: 0,
      errorRateBasisPoints: 0,
      latencyP50Ms: null,
      latencyP95Ms: null,
    })
  })

  test('tingkat galat dalam basis poin, dibulatkan', () => {
    const stats = summarizeRequests([ok(10), gagal(20), ok(30)])

    expect(stats.failures).toBe(1)
    expect(stats.errorRateBasisPoints).toBe(3_333)
  })

  test('urutan masukan tidak memengaruhi persentil, dan masukan tidak diubah', () => {
    const samples = [ok(900), ok(100), ok(500), ok(300), ok(700)]
    const before = samples.map((sample) => sample.latencyMs)

    const stats = summarizeRequests(samples)

    expect(stats.latencyP50Ms).toBe(500)
    expect(stats.latencyP95Ms).toBe(900)
    expect(samples.map((sample) => sample.latencyMs)).toEqual(before)
  })
})

describe('percentile', () => {
  test('peringkat terdekat: nilai yang benar-benar pernah terjadi', () => {
    const sorted = Array.from({ length: 100 }, (_, index) => index + 1)

    expect(percentile(sorted, 50)).toBe(50)
    expect(percentile(sorted, 95)).toBe(95)
    expect(percentile(sorted, 100)).toBe(100)
  })

  test('p0 dan satu sampel tidak keluar batas', () => {
    expect(percentile([42], 0)).toBe(42)
    expect(percentile([42], 95)).toBe(42)
    expect(percentile([], 50)).toBeNull()
  })
})
