import { describe, expect, test } from 'vitest'
import {
  RATE_LIMIT_DEFER_MS,
  RETRY_DELAYS_MS,
  afterTransientFailure,
  isDeliverableAddress,
  rateDecision,
  recipientKey,
} from './delivery.js'

const NOW = new Date('2026-10-08T10:00:00.000Z')
const SECRET = 'rahasia-uji-yang-panjangnya-cukup-0001'

describe('percobaan ulang berjenjang', () => {
  test('kegagalan pertama dicoba lagi setelah jenjang pertama', () => {
    expect(afterTransientFailure(0, NOW)).toEqual({
      kind: 'retry',
      attempts: 1,
      nextAttemptAt: new Date(NOW.getTime() + (RETRY_DELAYS_MS[0] ?? 0)),
    })
  })

  test('jeda bertambah di setiap jenjang', () => {
    const delays = RETRY_DELAYS_MS.map((_, attempts) => {
      const outcome = afterTransientFailure(attempts, NOW)
      return outcome.kind === 'retry' ? outcome.nextAttemptAt.getTime() - NOW.getTime() : 0
    })

    expect(delays).toEqual([...RETRY_DELAYS_MS])
    expect([...delays].sort((a, b) => a - b)).toEqual(delays)
  })

  test('sesudah jenjang terakhir, pemberitahuan masuk dead letter', () => {
    expect(afterTransientFailure(RETRY_DELAYS_MS.length, NOW)).toEqual({
      kind: 'dead',
      attempts: RETRY_DELAYS_MS.length + 1,
    })
  })
})

describe('alamat penerima', () => {
  test.each(['sari@example.com', 'a.b+tag@sub.example.co.id'])('%s dapat dikirimi', (email) => {
    expect(isDeliverableAddress(email)).toBe(true)
  })

  test.each(['', 'sari', 'sari@', '@example.com', 'sari@example', 'sa ri@example.com'])(
    '"%s" tidak sah dan tidak pernah dicoba',
    (email) => {
      expect(isDeliverableAddress(email)).toBe(false)
    },
  )

  test('alamat yang lebih panjang dari batas SMTP tidak sah', () => {
    expect(isDeliverableAddress(`${'a'.repeat(250)}@example.com`)).toBe(false)
  })

  test.each([
    'sari@example.com,mallory@evil.test',
    'sari@example.com;x@y.co',
    '"sari"@example.com',
    '<sari@example.com>',
  ])('"%s" menyelipkan penerima lain atau bukan alamat polos: ditolak', (email) => {
    expect(isDeliverableAddress(email)).toBe(false)
  })

  test('kunci penerima tidak memuat alamatnya, tidak peka huruf besar, dan bergantung pada rahasia', () => {
    const key = recipientKey('Sari@Example.com ', SECRET)

    expect(key).toBe(recipientKey('sari@example.com', SECRET))
    expect(key).not.toBe(recipientKey('sari@example.com', 'rahasia-lain-yang-cukup-panjang-000'))
    expect(key).not.toContain('sari')
    expect(key).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('pembatasan laju per penerima', () => {
  test('di bawah batas, surel boleh dikirim', () => {
    expect(rateDecision(9, 10, NOW)).toEqual({ kind: 'allow' })
  })

  test('mencapai batas, surel DITUNDA — bukan dibuang', () => {
    expect(rateDecision(10, 10, NOW)).toEqual({
      kind: 'defer',
      until: new Date(NOW.getTime() + RATE_LIMIT_DEFER_MS),
    })
  })
})
