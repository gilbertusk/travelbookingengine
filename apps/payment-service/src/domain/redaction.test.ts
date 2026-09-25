import { describe, expect, test } from 'vitest'
import { REDACTED, isSensitiveKey, redact } from './redaction.js'

/** Bentuk notifikasi Midtrans sungguhan, dengan nilai contoh. */
const NOTIFICATION = {
  order_id: 'ORDER-abc-1',
  transaction_id: 'midtrans-tx-1',
  transaction_status: 'settlement',
  status_code: '200',
  gross_amount: '1250000.00',
  payment_type: 'credit_card',
  signature_key: 'a'.repeat(128),
  masked_card: '481111-1114',
  card_type: 'credit',
}

describe('field yang diredaksi', () => {
  test('signature_key diredaksi', () => {
    const redacted = redact(NOTIFICATION) as Record<string, unknown>

    expect(redacted.signature_key).toBe(REDACTED)
  })

  test.each([
    'signature_key',
    'server_key',
    'client_key',
    'api_key',
    'apiKey',
    'authorization',
    'access_token',
    'card_number',
    'masked_card',
    'cvv',
    'secret',
    'password',
    'account_number',
  ])('"%s" dikenali sebagai sensitif', (key) => {
    expect(isSensitiveKey(key)).toBe(true)
  })

  /**
   * `masked_card` sudah disamarkan penyedia, tetapi tetap diredaksi: ia data
   * instrumen pembayaran, dan pola redaksi yang sama dipakai seluruh repo. Yang
   * hilang hanyalah kemampuan dukungan menebak kartu mana yang dipakai dari
   * catatan webhook — sementara pengenal transaksi, yang jauh lebih berguna
   * untuk itu, tetap ada.
   */
  test('masked_card diredaksi meski sudah disamarkan penyedia', () => {
    const redacted = redact(NOTIFICATION) as Record<string, unknown>

    expect(redacted.masked_card).toBe(REDACTED)
  })
})

describe('field yang dipertahankan', () => {
  test.each(['order_id', 'transaction_id', 'transaction_status', 'status_code', 'gross_amount'])(
    '"%s" tidak diredaksi',
    (key) => {
      const redacted = redact(NOTIFICATION) as Record<string, unknown>

      // Kelimanya adalah satu-satunya jalan menelusuri sengketa pembayaran.
      // Meredaksinya membuat tabel webhook_events tidak berguna.
      expect(redacted[key]).toBe(NOTIFICATION[key as keyof typeof NOTIFICATION])
      expect(isSensitiveKey(key)).toBe(false)
    },
  )
})

describe('bentuk masukan', () => {
  test('masukan tidak diubah', () => {
    const snapshot = structuredClone(NOTIFICATION)

    redact(NOTIFICATION)

    // Payload yang sama masih akan diverifikasi tanda tangannya. Meredaksi di
    // tempat berarti verifikasi itu kehilangan bahannya.
    expect(NOTIFICATION).toEqual(snapshot)
  })

  test('struktur bersarang ikut diredaksi', () => {
    const redacted = redact({ outer: { inner: { signature_key: 'rahasia' } } }) as {
      outer: { inner: { signature_key: unknown } }
    }

    expect(redacted.outer.inner.signature_key).toBe(REDACTED)
  })

  test('larik ikut diredaksi', () => {
    const redacted = redact([{ cvv: '123' }, { order_id: 'x' }]) as Record<string, unknown>[]

    expect(redacted[0]?.cvv).toBe(REDACTED)
    expect(redacted[1]?.order_id).toBe('x')
  })

  test('struktur yang sangat dalam dipotong, bukan membuat rekursi tanpa henti', () => {
    let deep: unknown = 'dasar'
    for (let level = 0; level < 20; level += 1) deep = { nested: deep }

    expect(() => redact(deep)).not.toThrow()
    expect(JSON.stringify(redact(deep))).toContain(REDACTED)
  })

  test.each([null, undefined, 42, 'teks', true])(
    'nilai primitif %s dikembalikan apa adanya',
    (value) => {
      expect(redact(value)).toBe(value)
    },
  )
})
