import { describe, expect, test } from 'vitest'
import { silentLogger } from '../testing/fakes.js'
import { deadLetterObserver } from './dead-letter-observer.js'

describe('deadLetterObserver', () => {
  test('perangkaian produksi (tanpa pengamat) tetap selesai tanpa melempar', async () => {
    // index.ts memanggilnya tanpa argumen kedua. Yang dibuktikan: pesan cacat
    // tidak menghentikan partisi, dan tidak ada produsen untuk dipanggil.
    await expect(
      deadLetterObserver(silentLogger()).send('tbe.dead-letter.v1', [
        { key: 'k', value: 'x', headers: { 'x-origin-topic': 'tbe.booking.v1' } },
      ]),
    ).resolves.toBeUndefined()
  })

  test('daftar kosong pun tidak melempar', async () => {
    const seen: string[] = []
    await deadLetterObserver(silentLogger(), (topic) => seen.push(topic)).send('t', [])
    expect(seen).toEqual(['t'])
  })
})
