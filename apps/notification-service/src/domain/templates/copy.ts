import { err, ok, type Result } from '@tbe/shared-kernel'
import {
  CHARGED_FAILURE_STATUSES,
  UNCHARGED_END_STATUSES,
  type BookingSnapshot,
} from '../booking-snapshot.js'
import type { CancelReason, MoneyAmount, ReviewConcern } from '../notification.js'
import { amount, stayDate } from './format.js'
import type { Fact, Message } from './layout.js'

/**
 * Isi setiap surel.
 *
 * Nada mengikuti halaman status pemesanan di apps/web: tenang, langsung,
 * memakai "kamu". Surel yang menyangkut uang membuka dengan nasib uangnya,
 * bukan dengan permintaan maaf — pengguna yang baru kehilangan kamar sedang
 * cemas soal uangnya, dan kalimat pertama harus menjawab itu (Step 24,
 * Catatan).
 *
 * Setiap surel juga menolak disusun bila keadaan pemesanan sudah tidak cocok
 * dengan isinya. Surel yang terlambat beberapa menit karena dicoba ulang tidak
 * boleh mengabarkan sesuatu yang sudah tidak benar.
 */

/** Perkiraan waktu sampainya pengembalian dana ke rekening (FR-23). */
export const REFUND_ARRIVAL = '3–14 hari kerja'

/** Sama dengan janji di halaman status pemesanan (apps/web, timeline.ts). */
export const REVIEW_CONTACT_WITHIN = '1×24 jam'

export type ComposeRefusal =
  /** Keadaan pemesanan tidak lagi cocok dengan isi surel. */
  | { readonly kind: 'outdated'; readonly status: string }
  /** Surel konfirmasi tanpa kode supplier tidak berguna di meja resepsionis. */
  | { readonly kind: 'missing_reference' }

type Built = Result<Message, ComposeRefusal>

const REFUND_ARRIVAL_SENTENCE = `Biasanya dana sampai dalam ${REFUND_ARRIVAL}, tergantung bank atau penyedia kartumu.`

function stayFacts(booking: BookingSnapshot): readonly Fact[] {
  return [
    ...(booking.roomTypeName === null ? [] : [{ label: 'Kamar', value: booking.roomTypeName }]),
    { label: 'Check-in', value: stayDate(booking.checkIn) },
    { label: 'Check-out', value: stayDate(booking.checkOut) },
    { label: 'Tamu', value: `${String(booking.guestCount)} orang` },
  ]
}

function stayPhrase(booking: BookingSnapshot): string {
  const room = booking.roomTypeName === null ? 'kamarmu' : `kamar ${booking.roomTypeName}`
  return `${room} untuk ${stayDate(booking.checkIn)} sampai ${stayDate(booking.checkOut)}`
}

function outdated(booking: BookingSnapshot): Built {
  return err({ kind: 'outdated', status: booking.status })
}

export function confirmedMessage(booking: BookingSnapshot): Built {
  if (booking.status !== 'CONFIRMED') return outdated(booking)
  if (booking.supplierRef === null) return err({ kind: 'missing_reference' })

  return ok({
    subject: `Pemesananmu terkonfirmasi — kode ${booking.supplierRef}`,
    lead: `Pemesananmu terkonfirmasi. Penyedia sudah menyimpan ${stayPhrase(booking)}.`,
    paragraphs: [
      `Kode pemesananmu di penyedia adalah ${booking.supplierRef}. E-voucher terlampir di surel ini; tunjukkan saat check-in, dicetak atau dari ponsel.`,
      'Simpan surel ini. Kode di atas adalah bukti pemesanan yang dikenali properti.',
    ],
    facts: [
      { label: 'Kode pemesanan penyedia', value: booking.supplierRef },
      ...stayFacts(booking),
      { label: 'Total dibayar', value: amount(booking.total) },
    ],
  })
}

export function failedMessage(booking: BookingSnapshot): Built {
  if (CHARGED_FAILURE_STATUSES.includes(booking.status)) {
    return ok({
      subject: 'Pemesananmu tidak dapat dikonfirmasi — dana dikembalikan otomatis',
      lead: `Dana ${amount(booking.total)} ${booking.status === 'REFUNDED' ? 'sudah' : 'sedang'} dikembalikan otomatis ke metode pembayaran yang kamu pakai. Kamu tidak perlu melakukan apa pun.`,
      paragraphs: [
        `${REFUND_ARRIVAL_SENTENCE} Kami mengirim surel lagi begitu pengembalian dikirim.`,
        `Yang terjadi: penyedia tidak dapat mengonfirmasi ${stayPhrase(booking)}, jadi pemesanan ini tidak dapat diselesaikan.`,
      ],
      facts: [...stayFacts(booking), { label: 'Dana dikembalikan', value: amount(booking.total) }],
    })
  }

  if (UNCHARGED_END_STATUSES.includes(booking.status)) {
    return ok({
      subject: 'Pemesananmu tidak dapat diselesaikan',
      lead: 'Tidak ada dana yang ditagih untuk pemesanan ini. Kamu tidak perlu melakukan apa pun.',
      paragraphs: [`Pemesanan ${stayPhrase(booking)} tidak dapat diselesaikan dan sudah ditutup.`],
      facts: stayFacts(booking),
    })
  }

  return outdated(booking)
}

const REVIEW_COPY: Readonly<
  Record<ReviewConcern, { readonly lead: string; readonly body: string }>
> = {
  room: {
    lead: 'Pembayaranmu tercatat dan aman. Kami belum mendapat kepastian dari penyedia tentang kamarmu, jadi tim kami memeriksanya langsung.',
    body: 'Bila kamar tidak dapat dipastikan, dana dikembalikan penuh.',
  },
  refund: {
    lead: 'Pembayaranmu tercatat dan aman. Pengembalian dana untuk pemesanan ini tertunda, jadi tim kami memeriksanya langsung.',
    body: 'Dana tetap akan dikembalikan penuh; yang sedang kami periksa adalah jalur pengembaliannya.',
  },
  unspecified: {
    lead: 'Pembayaranmu tercatat dan aman. Tim kami sedang memeriksa pemesanan ini langsung.',
    body: 'Bila pemesanan tidak dapat diselesaikan, dana dikembalikan penuh.',
  },
}

export function reviewMessage(booking: BookingSnapshot, concern: ReviewConcern): Built {
  if (booking.status !== 'NEEDS_REVIEW') return outdated(booking)

  const copy = REVIEW_COPY[concern]
  return ok({
    subject: 'Pemesananmu sedang kami periksa',
    lead: copy.lead,
    paragraphs: [
      `Kami menghubungimu lewat surel dalam ${REVIEW_CONTACT_WITHIN}. ${copy.body}`,
      'Sampai ada kabar dari kami, pemesanan ini belum terkonfirmasi. Jangan dulu memakainya untuk check-in.',
    ],
    facts: [...stayFacts(booking), { label: 'Pembayaran', value: amount(booking.total) }],
  })
}

const CANCELLED_STATUSES: readonly string[] = ['CANCELLED', 'EXPIRED', 'REFUNDED']

export function cancelledMessage(
  booking: BookingSnapshot,
  reason: CancelReason,
  refund: MoneyAmount | null,
): Built {
  if (!CANCELLED_STATUSES.includes(booking.status)) return outdated(booking)

  return ok({
    subject: 'Pemesananmu dibatalkan',
    lead: cancellationLead(reason, refund),
    paragraphs: [
      `Pemesanan ${stayPhrase(booking)} sudah dibatalkan${reasonClause(reason)}.`,
      ...(reason === 'user_request' && refund !== null && refund.amountMinor > 0
        ? [REFUND_ARRIVAL_SENTENCE]
        : []),
    ],
    facts: stayFacts(booking),
  })
}

function cancellationLead(reason: CancelReason, refund: MoneyAmount | null): string {
  if (reason === 'payment_failed' || reason === 'supplier_rejected') {
    return 'Tidak ada dana yang ditagih untuk pemesanan ini.'
  }
  if (refund === null) {
    return 'Pembatalanmu sudah kami terima. Rincian pengembalian dana kami kirim lewat surel terpisah begitu diproses.'
  }
  if (refund.amountMinor === 0) {
    return 'Sesuai kebijakan pembatalan rate plan yang kamu pesan, tidak ada dana yang dikembalikan untuk pembatalan ini.'
  }
  return `Dana ${amount(refund)} sedang dikembalikan ke metode pembayaran yang kamu pakai.`
}

function reasonClause(reason: CancelReason): string {
  switch (reason) {
    case 'user_request':
      return ' sesuai permintaanmu'
    case 'payment_failed':
      return ' karena pembayarannya tidak berhasil'
    case 'supplier_rejected':
      return ' karena kamar tidak lagi tersedia di penyedia'
    case 'unspecified':
      return ''
  }
}

export function refundedMessage(booking: BookingSnapshot, refunded: MoneyAmount | null): Built {
  const sent = refunded === null ? 'Pengembalian danamu' : `Pengembalian dana ${amount(refunded)}`

  return ok({
    subject: 'Pengembalian danamu sudah dikirim',
    lead: `${sent} sudah kami kirim ke metode pembayaran yang kamu pakai.`,
    paragraphs: [
      `${REFUND_ARRIVAL_SENTENCE} Bila sampai lewat dari itu dana belum terlihat, balas surel ini dan sertakan nomor pemesanan di bawah.`,
    ],
    facts: [
      ...stayFacts(booking),
      ...(refunded === null ? [] : [{ label: 'Dana dikembalikan', value: amount(refunded) }]),
    ],
  })
}
