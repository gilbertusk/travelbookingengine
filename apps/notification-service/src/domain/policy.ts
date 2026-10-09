import {
  commandDedupeKey,
  eventDedupeKey,
  type MoneyAmount,
  type NotificationContext,
  type NotificationRequest,
} from './notification.js'

/**
 * Kebijakan pemberitahuan: peristiwa mana menjadi surel apa.
 *
 * Inilah yang membedakan jalur Kafka dari jalur RabbitMQ. Peristiwa hanya
 * menyatakan sesuatu telah terjadi; service ini yang memutuskan apakah
 * pengguna perlu tahu, dan dengan surel apa. Penerbit peristiwa tidak tahu
 * service ini ada (ADR-0003).
 *
 * Fakta di bawah sengaja bentuk milik domain ini, bukan payload kontrak:
 * pemetaan dari kontrak tinggal di messaging/, dan aturan di sini dapat diuji
 * tanpa amplop pesan.
 */

export type CancellationReason =
  'user_request' | 'hold_expired' | 'payment_failed' | 'supplier_rejected'

export type FailureStage = 'price_check' | 'hold' | 'payment' | 'supplier_confirm' | 'voucher'

export type BookingFact =
  | { readonly kind: 'booking_confirmed'; readonly bookingId: string }
  | { readonly kind: 'voucher_issued'; readonly bookingId: string; readonly userId: string }
  | {
      readonly kind: 'booking_failed'
      readonly bookingId: string
      readonly stage: FailureStage
      readonly requiresManualReview: boolean
    }
  | {
      readonly kind: 'booking_cancelled'
      readonly bookingId: string
      readonly reason: CancellationReason
      readonly refundAmount: MoneyAmount | null
    }
  | {
      readonly kind: 'payment_refunded'
      readonly bookingId: string
      readonly refundId: string
      readonly amount: MoneyAmount
    }

export interface FactMeta {
  readonly messageId: string
  readonly correlationId: string
  readonly occurredAt: Date
}

export type SkipReason =
  /** Pengguna meninggalkan pemesanan sebelum membayar; tidak ada yang perlu dikabarkan. */
  | 'hold_expired'
  /** Peristiwa lama, mis. dibaca dari awal topik saat service pertama kali menyala. */
  | 'stale'

export type Decision =
  | { readonly kind: 'notify'; readonly request: NotificationRequest }
  | { readonly kind: 'skip'; readonly reason: SkipReason }

/**
 * Batas umur peristiwa yang masih layak dikabarkan.
 *
 * Consumer membaca topik dari awal untuk partisi yang belum punya offset
 * (lihat @tbe/messaging consumerResource). Tanpa batas ini, service yang baru
 * pertama kali dikerahkan mengirim surel untuk setiap pemesanan 90 hari
 * terakhir. Sebaliknya, service yang mati lebih lama dari batas ini kehilangan
 * surel untuk peristiwa selama ia mati — dicatat sebagai utang di README.
 */
export function decide(fact: BookingFact, meta: FactMeta, now: Date, maxAgeMs: number): Decision {
  if (now.getTime() - meta.occurredAt.getTime() > maxAgeMs) return { kind: 'skip', reason: 'stale' }

  const planned = plan(fact)
  if (planned.kind === 'skip') return planned

  return {
    kind: 'notify',
    request: {
      bookingId: fact.bookingId,
      userId: fact.kind === 'voucher_issued' ? fact.userId : null,
      dedupeKey: eventDedupeKey(
        planned.context.type,
        fact.bookingId,
        fact.kind === 'payment_refunded' ? fact.refundId : undefined,
      ),
      source: 'event',
      sourceMessageId: meta.messageId,
      correlationId: meta.correlationId,
      context: planned.context,
    },
  }
}

type Plan =
  | { readonly kind: 'context'; readonly context: NotificationContext }
  | { readonly kind: 'skip'; readonly reason: SkipReason }

function plan(fact: BookingFact): Plan {
  switch (fact.kind) {
    // Dua pemicu untuk SATU surel. Surel konfirmasi wajib membawa voucher,
    // dan voucher terbit sesudah konfirmasi. `booking.confirmed` mencatat
    // bahwa surel itu harus ada — penghantar menunggu vouchernya —
    // sedangkan `voucher.issued` membangunkan penghantar begitu berkasnya
    // siap. Mana pun yang tiba lebih dulu, kuncinya sama.
    case 'booking_confirmed':
    case 'voucher_issued':
      return contextOf({ type: 'booking_confirmed' })
    case 'booking_failed':
      return contextOf(failureContext(fact.stage, fact.requiresManualReview))
    case 'booking_cancelled':
      if (fact.reason === 'hold_expired') return { kind: 'skip', reason: 'hold_expired' }
      return contextOf({
        type: 'booking_cancelled',
        reason: fact.reason,
        refund: fact.refundAmount,
      })
    case 'payment_refunded':
      return contextOf({ type: 'refund_completed', amount: fact.amount })
  }
}

function contextOf(context: NotificationContext): Plan {
  return { kind: 'context', context }
}

/**
 * `booking.failed` yang menuntut pemeriksaan manual BUKAN kegagalan bagi
 * pengguna, dan tidak boleh dikabarkan sebagai kegagalan: kamarnya mungkin
 * sudah terpesan di supplier (US-05). Tahapnya menentukan apa yang diperiksa —
 * `payment` di sini berarti kompensasinya, refund, yang gagal.
 */
function failureContext(stage: FailureStage, requiresManualReview: boolean): NotificationContext {
  if (!requiresManualReview) return { type: 'booking_failed' }

  return { type: 'manual_review', concern: stage === 'payment' ? 'refund' : 'room' }
}

/**
 * Permintaan dari perintah `notification.send`.
 *
 * Tidak ada keputusan di sini — pengirim perintah sudah memutuskan surel apa
 * yang ia mau. Perintah juga tidak membawa fakta seperti alasan pembatalan
 * atau nilai pengembalian, jadi suratnya memakai bentuk umum: alasan
 * `unspecified`, nilai `null`. Template menyusun kalimat yang tetap benar
 * tanpa keduanya.
 */
export function fromCommand(input: {
  readonly commandId: string
  readonly correlationId: string
  readonly bookingId: string
  readonly userId: string
  readonly template: NotificationContext['type']
}): NotificationRequest {
  return {
    bookingId: input.bookingId,
    userId: input.userId,
    dedupeKey: commandDedupeKey(input.commandId),
    source: 'command',
    sourceMessageId: input.commandId,
    correlationId: input.correlationId,
    context: commandContext(input.template),
  }
}

function commandContext(template: NotificationContext['type']): NotificationContext {
  switch (template) {
    case 'booking_confirmed':
    case 'booking_failed':
      return { type: template }
    case 'manual_review':
      return { type: 'manual_review', concern: 'unspecified' }
    case 'booking_cancelled':
      return { type: 'booking_cancelled', reason: 'unspecified', refund: null }
    case 'refund_completed':
      return { type: 'refund_completed', amount: null }
  }
}
