import { ConflictError, UpstreamError, ValidationError } from '@tbe/shared-kernel'
import { describe, expect, test } from 'vitest'
import {
  RETRY_COUNT_HEADER,
  RETRY_TIERS,
  attemptsSoFar,
  dispositionFor,
  isRetryable,
} from './retry.js'

describe('attemptsSoFar', () => {
  test('mengembalikan nol untuk pesan yang belum pernah dicoba ulang', () => {
    expect(attemptsSoFar({})).toBe(0)
    expect(attemptsSoFar({ [RETRY_COUNT_HEADER]: 0 })).toBe(0)
  })

  test('membaca hitungan dari header kita sendiri', () => {
    expect(attemptsSoFar({ [RETRY_COUNT_HEADER]: 2 })).toBe(2)
  })

  test('menerima hitungan yang datang sebagai string', () => {
    // Header RabbitMQ dapat tiba sebagai Buffer atau string tergantung klien.
    expect(attemptsSoFar({ [RETRY_COUNT_HEADER]: '3' })).toBe(3)
  })

  test('mengabaikan nilai yang tidak masuk akal', () => {
    expect(attemptsSoFar({ [RETRY_COUNT_HEADER]: 'banyak' })).toBe(0)
    expect(attemptsSoFar({ [RETRY_COUNT_HEADER]: -5 })).toBe(0)
  })
})

describe('isRetryable', () => {
  test('pesan cacat tidak layak dicoba ulang', () => {
    // Menunggu tidak akan membuat payload yang salah menjadi benar.
    expect(isRetryable(new ValidationError('payload salah'))).toBe(false)
  })

  test('penolakan final dari sistem hulu tidak layak dicoba ulang', () => {
    expect(isRetryable(new ConflictError('sudah dibatalkan'))).toBe(false)
  })

  test('kegagalan sistem hulu layak dicoba ulang', () => {
    expect(isRetryable(new UpstreamError({ upstream: 'LUNA', message: 'gagal' }))).toBe(true)
  })

  test('galat yang tidak dikenal diperlakukan sebagai sementara', () => {
    // Membuang pesan karena galat tak dikenal lebih berbahaya daripada
    // mencobanya lagi.
    expect(isRetryable(new Error('entah apa'))).toBe(true)
    expect(isRetryable('string mentah')).toBe(true)
  })
})

describe('dispositionFor', () => {
  test('percobaan pertama masuk jenjang tercepat', () => {
    const disposition = dispositionFor(new Error('sementara'), {})

    expect(disposition).toEqual({ kind: 'retry', tier: RETRY_TIERS[0], attempt: 1 })
  })

  test('jenjang berikutnya dipakai sesuai jumlah percobaan', () => {
    const kedua = dispositionFor(new Error('x'), { [RETRY_COUNT_HEADER]: 1 })
    const ketiga = dispositionFor(new Error('x'), { [RETRY_COUNT_HEADER]: 2 })

    expect(kedua).toMatchObject({ kind: 'retry', attempt: 2, tier: RETRY_TIERS[1] })
    expect(ketiga).toMatchObject({ kind: 'retry', attempt: 3, tier: RETRY_TIERS[2] })
  })

  test('jenjang bertambah lama, tidak tetap', () => {
    const delays = RETRY_TIERS.map((tier) => tier.delayMs)

    expect(delays).toEqual([...delays].sort((a, b) => a - b))
    expect(new Set(delays).size).toBe(delays.length)
  })

  test('setelah jenjang terakhir habis, masuk dead letter', () => {
    const disposition = dispositionFor(new Error('x'), {
      [RETRY_COUNT_HEADER]: RETRY_TIERS.length,
    })

    expect(disposition).toEqual({ kind: 'dead_letter', reason: 'exhausted' })
  })

  test('pesan cacat langsung ke dead letter tanpa menghabiskan jenjang', () => {
    const disposition = dispositionFor(new ValidationError('cacat'), {})

    expect(disposition).toEqual({ kind: 'dead_letter', reason: 'not_retryable' })
  })
})
