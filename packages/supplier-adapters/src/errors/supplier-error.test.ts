import { describe, expect, test } from 'vitest'
import { createSkyAdapter } from '../adapters/sky.js'
import { fakeHttp, respondWith } from '../testing/fakes.js'
import { describeSupplierError, isRetryable, isSafeToBlindRetry } from './supplier-error.js'
import type { SupplierError } from './supplier-error.js'

/**
 * Pembedaan jenis kegagalan.
 *
 * Inilah yang membuat Step 11 dan Step 19 mungkin. Kalau seluruh kegagalan
 * berbentuk satu kelas galat, satu-satunya kebijakan yang dapat ditulis adalah
 * "coba lagi semuanya" atau "jangan coba lagi apa pun", dan keduanya salah.
 */

function error(kind: SupplierError['kind']): SupplierError {
  const base = { supplier: 'SKY', operation: 'book' } as const

  switch (kind) {
    case 'timeout':
      return { ...base, kind, timeoutMs: 1_000 }
    case 'unavailable':
    case 'rate_limited':
      return { ...base, kind, retryAfterSeconds: 5 }
    case 'invalid_response':
      return { ...base, kind, reason: 'bukan JSON' }
    case 'not_found':
      return { ...base, kind, what: 'booking' }
    case 'upstream_error':
      return { ...base, kind, status: 500 }
    default:
      return { ...base, kind }
  }
}

describe('kelayakan dicoba ulang', () => {
  test('kegagalan sementara layak dicoba ulang', () => {
    for (const kind of ['timeout', 'unavailable', 'rate_limited', 'upstream_error'] as const) {
      expect(isRetryable(error(kind))).toBe(true)
    }
  })

  test('jawaban yang tidak akan berubah tidak layak dicoba ulang', () => {
    // Mencoba ulang sold_out adalah pemborosan murni: kamarnya tetap habis,
    // dan setiap percobaan menambah beban ke supplier yang sudah menjawab.
    for (const kind of ['sold_out', 'price_changed', 'not_found', 'hold_expired'] as const) {
      expect(isRetryable(error(kind))).toBe(false)
    }
  })

  test('respons cacat tidak dicoba ulang', () => {
    // Supplier yang mengirim isi tidak dapat diurai kemungkinan besar akan
    // mengirimkannya lagi; yang dibutuhkan orang, bukan percobaan kedua.
    expect(isRetryable(error('invalid_response'))).toBe(false)
  })

  test('pembatalan yang sudah terjadi bukan kegagalan yang perlu diulang', () => {
    expect(isRetryable(error('already_cancelled'))).toBe(false)
  })
})

describe('keamanan mengulang tanpa memeriksa', () => {
  test('hanya aman ketika supplier pasti belum menerima permintaannya', () => {
    expect(isSafeToBlindRetry(error('unavailable'))).toBe(true)
    expect(isSafeToBlindRetry(error('rate_limited'))).toBe(true)
  })

  test('batas waktu TIDAK aman diulang langsung', () => {
    // Inilah sumber pemesanan ganda: batas waktu berarti supplier mungkin
    // sudah membuat pemesanan dan hanya responsnya yang tidak sampai.
    // Jalan yang benar adalah bertanya lebih dulu dengan idempotency key.
    expect(isSafeToBlindRetry(error('timeout'))).toBe(false)
  })

  test('galat hulu juga tidak aman diulang langsung', () => {
    // 500 dapat berarti supplier gagal setelah menyimpan pemesanan.
    expect(isSafeToBlindRetry(error('upstream_error'))).toBe(false)
  })
})

describe('keterangan untuk log', () => {
  test('menyebut supplier dan operasi', () => {
    expect(describeSupplierError(error('timeout'))).toBe('SKY/book: timeout')
  })
})

describe('pemetaan konflik dari respons sungguhan', () => {
  const stay = { checkIn: '2026-11-10', checkOut: '2026-11-12' }

  test('409 SOLD_OUT menjadi sold_out', async () => {
    const adapter = createSkyAdapter(
      fakeHttp(respondWith(JSON.stringify({ error: 'SOLD_OUT' }), { status: 409 })),
    )

    const result = await adapter.hold('r-1', stay, 2)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('sold_out')
  })

  test('409 PRICE_CHANGED menjadi price_changed', async () => {
    const adapter = createSkyAdapter(
      fakeHttp(respondWith(JSON.stringify({ error: 'PRICE_CHANGED' }), { status: 409 })),
    )

    const result = await adapter.priceCheck('r-1', stay)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('price_changed')
  })

  test('409 HOLD_EXPIRED menjadi hold_expired, bukan sold_out', async () => {
    // Keduanya sama-sama 409 dan artinya berbeda: hold yang kedaluwarsa aman
    // diulang dari awal, kamar yang habis tidak.
    const adapter = createSkyAdapter(
      fakeHttp(respondWith(JSON.stringify({ error: 'HOLD_EXPIRED' }), { status: 409 })),
    )

    const result = await adapter.book('h-1', { fullName: 'Budi' }, 'kunci-1')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('hold_expired')
  })

  test('409 ALREADY_CANCELLED menjadi already_cancelled', async () => {
    const adapter = createSkyAdapter(
      fakeHttp(respondWith(JSON.stringify({ error: 'ALREADY_CANCELLED' }), { status: 409 })),
    )

    const result = await adapter.cancel('bkg-1')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('already_cancelled')
  })

  test('409 dengan kode yang tidak dikenali tidak ditebak', async () => {
    // Menganggapnya sold_out akan menyembunyikan kamar yang sebenarnya ada.
    const adapter = createSkyAdapter(
      fakeHttp(respondWith(JSON.stringify({ error: 'ENTAH_APA' }), { status: 409 })),
    )

    const result = await adapter.hold('r-1', stay, 2)

    expect(result.ok).toBe(false)
    if (result.ok || result.error.kind !== 'upstream_error') return
    expect(result.error.code).toBe('ENTAH_APA')
  })

  test('404 menjadi not_found', async () => {
    const adapter = createSkyAdapter(
      fakeHttp(respondWith(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 })),
    )

    const result = await adapter.getBooking('bkg-tidak-ada')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('not_found')
  })

  test('500 menjadi upstream_error dengan statusnya', async () => {
    const adapter = createSkyAdapter(fakeHttp(respondWith('kacau', { status: 500 })))

    const result = await adapter.getBooking('bkg-1')

    expect(result.ok).toBe(false)
    if (result.ok || result.error.kind !== 'upstream_error') return
    expect(result.error.status).toBe(500)
  })
})
