import { describe, expect, test } from 'vitest'
import type { BookingSnapshot } from '../booking-snapshot.js'
import type { NotificationContext } from '../notification.js'
import { REFUND_ARRIVAL, REVIEW_CONTACT_WITHIN, compose, type EmailContent } from './compose.js'

const BOOKING_ID = '018f2a1c-0000-7000-8000-00000000b001'

function booking(overrides: Partial<BookingSnapshot> = {}): BookingSnapshot {
  return {
    bookingId: BOOKING_ID,
    userId: '7b9e2d14-1f3a-4e5c-8d6b-2a1c0f9e8d7c',
    status: 'CONFIRMED',
    supplierRef: 'SKY-BK-7F3A21',
    checkIn: '2026-11-10',
    checkOut: '2026-11-12',
    guestCount: 2,
    leadGuest: { fullName: 'Sari Wulandari', email: 'sari@example.com' },
    roomTypeName: 'Deluxe King',
    total: { amountMinor: 2_442_000, currency: 'IDR' },
    ...overrides,
  }
}

function composed(context: NotificationContext, snapshot: BookingSnapshot): EmailContent {
  const result = compose(context, snapshot)
  if (!result.ok) throw new Error(`ditolak: ${result.error.kind}`)
  return result.value
}

/** Kalimat pertama isi surel, sesudah salam. */
function firstSentence(email: EmailContent): string {
  const body = email.text.split('\n\n')[1] ?? ''
  return body.split(/(?<=\.)\s/)[0] ?? ''
}

const EVERY_TEMPLATE: readonly [NotificationContext, BookingSnapshot][] = [
  [{ type: 'booking_confirmed' }, booking()],
  [{ type: 'booking_failed' }, booking({ status: 'FAILED', supplierRef: null })],
  [{ type: 'booking_failed' }, booking({ status: 'CANCELLED', supplierRef: null })],
  [{ type: 'manual_review', concern: 'room' }, booking({ status: 'NEEDS_REVIEW' })],
  [{ type: 'manual_review', concern: 'refund' }, booking({ status: 'NEEDS_REVIEW' })],
  [{ type: 'manual_review', concern: 'unspecified' }, booking({ status: 'NEEDS_REVIEW' })],
  [
    { type: 'booking_cancelled', reason: 'user_request', refund: null },
    booking({ status: 'CANCELLED' }),
  ],
  [{ type: 'refund_completed', amount: null }, booking({ status: 'REFUNDED' })],
]

describe('setiap template', () => {
  test.each(EVERY_TEMPLATE)('%o punya versi teks biasa tanpa tag HTML', (context, snapshot) => {
    const email = composed(context, snapshot)

    expect(email.text.length).toBeGreaterThan(100)
    expect(email.text).not.toMatch(/<[a-z/]/i)
    expect(email.subject.length).toBeGreaterThan(0)
  })

  test.each(EVERY_TEMPLATE)('%o versi HTML memuat isi yang sama', (context, snapshot) => {
    const email = composed(context, snapshot)

    expect(email.html).toContain('<html')
    expect(email.html).toContain(email.subject.replace(/&/g, '&amp;'))
    expect(email.html).toContain('Sari Wulandari')
  })

  test('nama tamu di-escape di HTML, tetapi utuh di teks biasa', () => {
    const name = 'Sari <script>alert(1)</script>'

    const email = composed(
      { type: 'booking_confirmed' },
      booking({ leadGuest: { fullName: name, email: 'x@example.com' } }),
    )

    expect(email.html).not.toContain('<script>')
    expect(email.html).toContain('&lt;script&gt;')
    expect(email.text).toContain(name)
  })

  test('nomor pemesanan selalu disebut, supaya pengguna dapat merujuknya', () => {
    for (const [context, snapshot] of EVERY_TEMPLATE) {
      expect(composed(context, snapshot).text).toContain(BOOKING_ID)
    }
  })
})

describe('surel kegagalan pemesanan (FR-23)', () => {
  test('kalimat pertama menjawab soal uang: jumlahnya dan bahwa ia dikembalikan otomatis', () => {
    const email = composed(
      { type: 'booking_failed' },
      booking({ status: 'FAILED', supplierRef: null }),
    )

    const first = firstSentence(email)
    expect(first).toContain('Rp')
    expect(first).toContain('2.442.000')
    expect(first).toMatch(/dikembalikan/)
  })

  test('menyebut perkiraan waktu sampainya dana', () => {
    const email = composed(
      { type: 'booking_failed' },
      booking({ status: 'FAILED', supplierRef: null }),
    )

    expect(email.text).toContain(REFUND_ARRIVAL)
    expect(email.text).toMatch(/tidak perlu melakukan apa pun/)
  })

  test('pemesanan yang sudah REFUNDED tetap dijelaskan sebagai pengembalian, bukan tagihan baru', () => {
    const email = composed({ type: 'booking_failed' }, booking({ status: 'REFUNDED' }))

    expect(firstSentence(email)).toMatch(/dikembalikan/)
  })

  test('pemesanan yang gagal SEBELUM ditagih menyatakan tidak ada dana yang ditagih', () => {
    const email = composed(
      { type: 'booking_failed' },
      booking({ status: 'CANCELLED', supplierRef: null }),
    )

    expect(firstSentence(email)).toMatch(/[Tt]idak ada dana yang ditagih/)
    expect(email.text).not.toContain(REFUND_ARRIVAL)
  })

  test('tidak membuka dengan permintaan maaf panjang', () => {
    const email = composed({ type: 'booking_failed' }, booking({ status: 'FAILED' }))

    expect(firstSentence(email)).not.toMatch(/maaf/i)
  })

  test('ditolak bila pengembaliannya tertahan (NEEDS_REVIEW): janji "otomatis" tidak lagi benar', () => {
    const result = compose({ type: 'booking_failed' }, booking({ status: 'NEEDS_REVIEW' }))

    expect(result).toEqual({ ok: false, error: { kind: 'outdated', status: 'NEEDS_REVIEW' } })
  })

  test('ditolak untuk pemesanan yang ternyata terkonfirmasi — surel kegagalan di sana bohong', () => {
    const result = compose({ type: 'booking_failed' }, booking({ status: 'CONFIRMED' }))

    expect(result).toEqual({ ok: false, error: { kind: 'outdated', status: 'CONFIRMED' } })
  })
})

describe('surel pemeriksaan manual (NEEDS_REVIEW)', () => {
  test('jujur: sedang diperiksa, belum berhasil dan belum gagal', () => {
    const email = composed(
      { type: 'manual_review', concern: 'room' },
      booking({ status: 'NEEDS_REVIEW' }),
    )

    expect(email.subject).toMatch(/periksa/)
    expect(email.text).toMatch(/belum terkonfirmasi/)
    expect(email.text).not.toMatch(/berhasil|gagal/i)
  })

  test('menyebut kapan pengguna akan dihubungi', () => {
    const email = composed(
      { type: 'manual_review', concern: 'room' },
      booking({ status: 'NEEDS_REVIEW' }),
    )

    expect(email.text).toContain(REVIEW_CONTACT_WITHIN)
  })

  test('kalimat pertama menenangkan soal uang', () => {
    const email = composed(
      { type: 'manual_review', concern: 'room' },
      booking({ status: 'NEEDS_REVIEW' }),
    )

    expect(firstSentence(email)).toMatch(/aman/)
  })

  test('pemeriksaan pengembalian dana tidak berbicara soal kamar yang belum pasti', () => {
    const email = composed(
      { type: 'manual_review', concern: 'refund' },
      booking({ status: 'NEEDS_REVIEW' }),
    )

    expect(email.text).toMatch(/pengembalian dana/i)
    expect(email.text).not.toMatch(/kepastian dari penyedia/)
  })

  test('ditolak bila pemeriksaannya sudah selesai sebelum surel dikirim', () => {
    const result = compose(
      { type: 'manual_review', concern: 'room' },
      booking({ status: 'CONFIRMED' }),
    )

    expect(result).toEqual({ ok: false, error: { kind: 'outdated', status: 'CONFIRMED' } })
  })
})

describe('surel konfirmasi', () => {
  test('menyebut kode pemesanan supplier, kamar, dan tanggal lokal tanpa konversi zona', () => {
    const email = composed({ type: 'booking_confirmed' }, booking())

    expect(email.subject).toContain('SKY-BK-7F3A21')
    expect(email.text).toContain('Deluxe King')
    expect(email.text).toContain('10 November 2026')
    expect(email.text).toContain('12 November 2026')
    expect(email.text).toMatch(/voucher.*terlampir/i)
  })

  test('tetap tersusun tanpa nama kamar untuk pemesanan lama', () => {
    const email = composed({ type: 'booking_confirmed' }, booking({ roomTypeName: null }))

    expect(email.text).not.toContain('null')
  })

  test('ditolak untuk pemesanan yang belum CONFIRMED', () => {
    expect(compose({ type: 'booking_confirmed' }, booking({ status: 'PAID' }))).toEqual({
      ok: false,
      error: { kind: 'outdated', status: 'PAID' },
    })
  })

  test('ditolak tanpa kode pemesanan supplier — tanpa kode itu tamu tidak dapat check-in', () => {
    expect(compose({ type: 'booking_confirmed' }, booking({ supplierRef: null }))).toEqual({
      ok: false,
      error: { kind: 'missing_reference' },
    })
  })
})

describe('surel pembatalan', () => {
  const cancelled = booking({ status: 'CANCELLED', supplierRef: null })

  test('atas permintaan pengguna, dengan nilai pengembalian', () => {
    const email = composed(
      {
        type: 'booking_cancelled',
        reason: 'user_request',
        refund: { amountMinor: 1_221_000, currency: 'IDR' },
      },
      cancelled,
    )

    expect(firstSentence(email)).toContain('1.221.000')
    expect(email.text).toContain(REFUND_ARRIVAL)
  })

  test('nilai pengembalian nol dinyatakan terus terang', () => {
    const email = composed(
      {
        type: 'booking_cancelled',
        reason: 'user_request',
        refund: { amountMinor: 0, currency: 'IDR' },
      },
      cancelled,
    )

    expect(firstSentence(email)).toMatch(/tidak ada dana yang dikembalikan/i)
  })

  test('nilai pengembalian yang belum diketahui dijanjikan lewat surel berikutnya', () => {
    const email = composed(
      { type: 'booking_cancelled', reason: 'user_request', refund: null },
      cancelled,
    )

    expect(email.text).toMatch(/surel terpisah/)
  })

  test.each(['payment_failed', 'supplier_rejected'] as const)(
    'pembatalan %s menyatakan tidak ada dana yang ditagih',
    (reason) => {
      const email = composed({ type: 'booking_cancelled', reason, refund: null }, cancelled)

      expect(firstSentence(email)).toMatch(/[Tt]idak ada dana yang ditagih/)
    },
  )

  test('ditolak untuk pemesanan yang masih berjalan', () => {
    expect(
      compose(
        { type: 'booking_cancelled', reason: 'unspecified', refund: null },
        booking({ status: 'HELD' }),
      ),
    ).toEqual({ ok: false, error: { kind: 'outdated', status: 'HELD' } })
  })
})

describe('surel pengembalian dana selesai', () => {
  test('menyebut nilai dan perkiraan sampainya', () => {
    const email = composed(
      { type: 'refund_completed', amount: { amountMinor: 2_442_000, currency: 'IDR' } },
      booking({ status: 'REFUNDED' }),
    )

    expect(firstSentence(email)).toContain('2.442.000')
    expect(email.text).toContain(REFUND_ARRIVAL)
  })

  test('nilai dalam dolar diformat sebagai dolar', () => {
    const email = composed(
      { type: 'refund_completed', amount: { amountMinor: 12_550, currency: 'USD' } },
      booking({ status: 'REFUNDED' }),
    )

    expect(email.text).toContain('$125.50')
  })
})
