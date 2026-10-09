// Mengirim satu contoh dari setiap template ke Mailpit lokal, untuk dilihat
// di http://localhost:8025. Memakai template dan pengirim SMTP yang sama
// dengan service — hasil build di dist/, jadi jalankan `pnpm build` dulu.
//
//   pnpm --filter @tbe/notification-service preview:mail
//
// Hanya untuk pengembangan: alamat tujuan contoh, Mailpit menerima apa saja.

import { compose } from '../dist/domain/templates/compose.js'
import { createSmtpSender, createSmtpTransport } from '../dist/infrastructure/smtp-sender.js'

const SMTP_HOST = process.env.SMTP_HOST ?? 'localhost'
const SMTP_PORT = Number(process.env.SMTP_PORT ?? '1025')

/** Bukan voucher sungguhan — hanya supaya lampiran terlihat di Mailpit. */
const SAMPLE_PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')

const booking = (status, overrides = {}) => ({
  bookingId: '018f2a1c-0000-7000-8000-00000000b001',
  userId: '7b9e2d14-1f3a-4e5c-8d6b-2a1c0f9e8d7c',
  status,
  supplierRef: 'SKY-BK-7F3A21',
  checkIn: '2026-11-10',
  checkOut: '2026-11-12',
  guestCount: 2,
  leadGuest: { fullName: 'Sari Wulandari', email: 'sari@example.com' },
  roomTypeName: 'Deluxe King',
  total: { amountMinor: 2_442_000, currency: 'IDR' },
  ...overrides,
})

const SAMPLES = [
  [{ type: 'booking_confirmed' }, booking('CONFIRMED'), true],
  [{ type: 'booking_failed' }, booking('FAILED', { supplierRef: null }), false],
  [
    { type: 'manual_review', concern: 'room' },
    booking('NEEDS_REVIEW', { supplierRef: null }),
    false,
  ],
  [
    { type: 'manual_review', concern: 'refund' },
    booking('NEEDS_REVIEW', { supplierRef: null }),
    false,
  ],
  [
    {
      type: 'booking_cancelled',
      reason: 'user_request',
      refund: { amountMinor: 1_221_000, currency: 'IDR' },
    },
    booking('CANCELLED'),
    false,
  ],
  [
    { type: 'refund_completed', amount: { amountMinor: 2_442_000, currency: 'IDR' } },
    booking('REFUNDED', { supplierRef: null }),
    false,
  ],
]

const smtp = createSmtpTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: false,
  user: undefined,
  password: undefined,
  timeoutMs: 5_000,
})
const sender = createSmtpSender(smtp.transport, 'Lintang <bantuan@lintang.local>')

let failures = 0
for (const [context, snapshot, hasVoucher] of SAMPLES) {
  const email = compose(context, snapshot)
  if (!email.ok) {
    process.stderr.write(`${context.type}: ditolak (${email.error.kind})\n`)
    failures += 1
    continue
  }
  const result = await sender.send({
    to: snapshot.leadGuest.email,
    ...email.value,
    attachments: hasVoucher
      ? [{ filename: 'e-voucher.pdf', contentType: 'application/pdf', content: SAMPLE_PDF }]
      : [],
  })
  process.stdout.write(`${context.type}: ${result.kind}\n`)
  if (result.kind !== 'sent') failures += 1
}

await smtp.resource.stop()
process.exitCode = failures === 0 ? 0 : 1
