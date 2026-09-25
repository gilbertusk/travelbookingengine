import { describe, expect, test } from 'vitest'
import { expectedSignature } from '../domain/signature.js'
import { createSignatureVerifier } from './signature-verifier.js'

/** Nilai contoh untuk uji. Server key sandbox yang asli hanya ada di env. */
const SERVER_KEY = 'SB-Mid-server-TESTKEY'

const NOTIFICATION = {
  orderId: 'ORDER-abc-1',
  statusCode: '200',
  grossAmount: '1250000.00',
}

describe('pengikatan server key', () => {
  test('notifikasi yang ditandatangani dengan kunci yang sama diterima', () => {
    const verifier = createSignatureVerifier(SERVER_KEY)
    const signatureKey = expectedSignature({ ...NOTIFICATION, serverKey: SERVER_KEY })

    expect(verifier.isValid({ ...NOTIFICATION, signatureKey })).toBe(true)
  })

  /**
   * Yang sesungguhnya diuji di sini: bahwa kunci yang dipegang verifikator
   * benar-benar dipakai. Verifikator yang mengabaikan kuncinya akan lulus uji di
   * atas dan gagal di bawah — dan verifikator yang selalu menjawab benar adalah
   * cacat yang paling mudah tidak disadari.
   */
  test('notifikasi yang ditandatangani dengan kunci lain ditolak', () => {
    const verifier = createSignatureVerifier(SERVER_KEY)
    const signatureKey = expectedSignature({
      ...NOTIFICATION,
      serverKey: 'SB-Mid-server-KUNCI-LAIN',
    })

    expect(verifier.isValid({ ...NOTIFICATION, signatureKey })).toBe(false)
  })

  test('tanda tangan yang tidak berbentuk heksadesimal ditolak tanpa melempar', () => {
    const verifier = createSignatureVerifier(SERVER_KEY)

    expect(() =>
      verifier.isValid({ ...NOTIFICATION, signatureKey: 'bukan-tanda-tangan' }),
    ).not.toThrow()
    expect(verifier.isValid({ ...NOTIFICATION, signatureKey: 'bukan-tanda-tangan' })).toBe(false)
  })

  test('nilai yang diubah membatalkan tanda tangan', () => {
    const verifier = createSignatureVerifier(SERVER_KEY)
    const signatureKey = expectedSignature({ ...NOTIFICATION, serverKey: SERVER_KEY })

    // gross_amount termasuk yang ditandatangani, jadi menaikkan nilai tagihan
    // tanpa mengetahui server key tidak mungkin.
    expect(verifier.isValid({ ...NOTIFICATION, grossAmount: '9250000.00', signatureKey })).toBe(
      false,
    )
  })
})
