import type { Currency } from '@tbe/money'
import { parseGrossAmount } from '../domain/gross-amount.js'
import {
  applyProviderOutcome,
  type AppliedPayment,
  type Payment,
  type ProviderNotification,
} from '../domain/payment.js'
import { mapMidtransStatus } from '../domain/provider-status.js'
import { redact } from '../domain/redaction.js'
import type { PaymentDeps, WebhookOutcome } from './ports.js'

/**
 * Pemrosesan notifikasi penyedia. Inti Step 18.
 *
 * Urutan langkahnya adalah keputusannya, dan urutan itu tidak boleh ditukar:
 *
 * 1. **Verifikasi tanda tangan.** Sebelum apa pun yang lain, termasuk sebelum
 *    menyentuh buku besar. Notifikasi tanpa tanda tangan sah tidak boleh
 *    menempati pengenal peristiwanya — kalau boleh, siapa pun yang mengetahui
 *    sebuah transaction_id dapat mengirim notifikasi palsu lebih dulu dan
 *    membuat notifikasi sungguhan yang tiba kemudian dianggap duplikat.
 * 2. **Pemetaan status dan penguraian nilai.** Keduanya tanpa efek samping, dan
 *    notifikasi yang tidak dapat diproses karena itu tidak perlu mengklaim apa
 *    pun. Pengiriman ulangnya tidak berbahaya: tidak ada keadaan yang berubah.
 * 3. **Klaim buku besar.** Baru di sini, dan hanya untuk notifikasi yang akan
 *    menyentuh keadaan pembayaran. Yang memutuskan pemenang adalah batasan UNIK
 *    basis data, bukan pemeriksaan "sudah pernah ada?" di berkas ini — lihat
 *    [WebhookLedger], yang bentuknya tidak menyediakan cara menulisnya salah.
 * 4. **Simpan keadaan, lalu terbitkan peristiwa, lalu tutup klaim.** Urutan
 *    inilah yang membuat consumer tidak pernah membaca peristiwa tentang
 *    keadaan yang belum ada.
 */

export interface RawNotification {
  /** `order_id` dari penyedia. Sama dengan id pembayaran — lihat create-payment-intent.ts. */
  readonly orderId: string
  /** `transaction_id`. Menjadi pengenal peristiwa untuk idempotensi. */
  readonly transactionId: string
  readonly transactionStatus: string
  readonly fraudStatus: string | undefined
  readonly statusCode: string
  /** MENTAH. Bahan tanda tangan; memformat ulangnya membatalkan verifikasi. */
  readonly grossAmount: string
  readonly currency: Currency
  readonly signatureKey: string
  /** Payload utuh, untuk dicatat setelah diredaksi. */
  readonly payload: unknown
}

export type IgnoreReason =
  'duplicate_status' | 'out_of_order' | 'provider_refund_status' | 'unsupported_status'

export type RejectReason =
  'invalid_signature' | 'unknown_payment' | 'amount_mismatch' | 'invalid_amount'

export type NotificationHandling =
  | { readonly kind: 'applied'; readonly payment: Payment }
  | { readonly kind: 'duplicate'; readonly outcome: WebhookOutcome }
  | { readonly kind: 'in_progress' }
  | { readonly kind: 'ignored'; readonly why: IgnoreReason }
  | { readonly kind: 'rejected'; readonly why: RejectReason }

export async function handleNotification(
  deps: PaymentDeps,
  raw: RawNotification,
): Promise<NotificationHandling> {
  const checked = precheck(deps, raw)

  if (checked.kind === 'stop') return checked.handling

  const claim = await deps.ledger.claim({
    providerEventId: raw.transactionId,
    payload: redact(raw.payload),
  })

  if (claim.kind === 'already_processed') return { kind: 'duplicate', outcome: claim.outcome }

  if (claim.kind === 'in_progress') {
    // BUKAN duplikat yang sudah selesai. Menjawab berhasil di sini berarti
    // notifikasi itu hilang selamanya bila proses yang mengklaim sudah mati,
    // dan pembayaran tertinggal PENDING tanpa ada yang akan mengubahnya.
    deps.logger.warn(
      { providerEventId: raw.transactionId, orderId: raw.orderId },
      'notifikasi sedang diproses pihak lain, penyedia diminta mengirim ulang',
    )

    return { kind: 'in_progress' }
  }

  return await applyToPayment(deps, raw, checked.notification)
}

type Precheck =
  | { readonly kind: 'processable'; readonly notification: ProviderNotification }
  | { readonly kind: 'stop'; readonly handling: NotificationHandling }

function precheck(deps: PaymentDeps, raw: RawNotification): Precheck {
  const context = { providerEventId: raw.transactionId, orderId: raw.orderId }

  if (!isSignatureValid(deps, raw)) {
    // `security: true` supaya peringatan ini dapat disaring terpisah dari
    // peringatan degradasi. Tanda tangan yang ditolak TIDAK ikut dicatat.
    deps.logger.warn(
      { ...context, security: true, transactionStatus: raw.transactionStatus },
      'tanda tangan notifikasi pembayaran tidak sah, notifikasi ditolak',
    )

    return stop({ kind: 'rejected', why: 'invalid_signature' })
  }

  const mapping = mapMidtransStatus(raw.transactionStatus, raw.fraudStatus)

  if (mapping.kind === 'unsupported') {
    deps.logger.warn(
      { ...context, transactionStatus: raw.transactionStatus },
      'status penyedia belum dipetakan, notifikasi diabaikan alih-alih ditebak',
    )

    return stop({ kind: 'ignored', why: 'unsupported_status' })
  }

  if (mapping.kind === 'ignored') {
    deps.logger.info({ ...context, why: mapping.why }, 'notifikasi refund penyedia diabaikan')

    return stop({ kind: 'ignored', why: 'provider_refund_status' })
  }

  const amount = parseGrossAmount(raw.grossAmount, raw.currency)

  if (amount === undefined) {
    deps.logger.warn({ ...context }, 'gross_amount penyedia tidak dapat diurai')

    return stop({ kind: 'rejected', why: 'invalid_amount' })
  }

  return {
    kind: 'processable',
    notification: {
      outcome: mapping.outcome,
      gatewayRef: raw.transactionId,
      amount,
      // Status mentah penyedia dipakai sebagai alasan kegagalan. Ia disimpan apa
      // adanya dan diterjemahkan saat ditampilkan, bukan sebelum disimpan —
      // catatan yang sudah diterjemahkan tidak dapat dipetakan kembali.
      reason: raw.transactionStatus,
    },
  }
}

function isSignatureValid(deps: PaymentDeps, raw: RawNotification): boolean {
  return deps.verifier.isValid({
    orderId: raw.orderId,
    statusCode: raw.statusCode,
    grossAmount: raw.grossAmount,
    signatureKey: raw.signatureKey,
  })
}

function stop(handling: NotificationHandling): Precheck {
  return { kind: 'stop', handling }
}

async function applyToPayment(
  deps: PaymentDeps,
  raw: RawNotification,
  notification: ProviderNotification,
): Promise<NotificationHandling> {
  const payment = await deps.payments.findById(raw.orderId)

  if (payment === undefined) return await rejectUnknownPayment(deps, raw)

  const result = applyProviderOutcome(payment, notification)

  switch (result.kind) {
    case 'applied':
      return await commit(deps, raw, result.payment)

    case 'unchanged':
      await deps.ledger.complete(raw.transactionId, 'ignored_duplicate_status', payment.id)

      return { kind: 'ignored', why: 'duplicate_status' }

    case 'out_of_order':
      deps.logger.warn(
        {
          providerEventId: raw.transactionId,
          paymentId: payment.id,
          current: payment.status,
          attempted: result.attempted,
        },
        'notifikasi tidak berurutan diabaikan, keadaan final dipertahankan',
      )
      await deps.ledger.complete(raw.transactionId, 'ignored_out_of_order', payment.id)

      return { kind: 'ignored', why: 'out_of_order' }

    case 'amount_mismatch':
      return await rejectMismatch(deps, raw, payment, result.notified.amountMinor)
  }
}

async function commit(
  deps: PaymentDeps,
  raw: RawNotification,
  payment: AppliedPayment,
): Promise<NotificationHandling> {
  // Keadaan LEBIH DULU. Peristiwa yang mendahului penyimpanan akan dibaca saga
  // yang lalu menanyakan pembayaran yang belum ada.
  await deps.payments.update(payment)
  await publish(deps, payment)
  await deps.ledger.complete(raw.transactionId, 'applied', payment.id)

  deps.logger.info(
    { paymentId: payment.id, bookingId: payment.bookingId, status: payment.status },
    'notifikasi pembayaran diterapkan',
  )

  return { kind: 'applied', payment }
}

/**
 * Menerbitkan peristiwa yang sesuai keadaan baru.
 *
 * Menerima [AppliedPayment], bukan `Payment`: notifikasi penyedia hanya dapat
 * menghasilkan SUCCEEDED atau FAILED, dan tipe itu yang menyatakannya. Dengan
 * `Payment`, berkas ini harus punya cabang untuk tiga keadaan yang tidak pernah
 * mungkin tiba di sini — cabang yang tidak dapat diuji karena tidak dapat
 * dibuktikan benar.
 */
async function publish(deps: PaymentDeps, payment: AppliedPayment): Promise<void> {
  if (payment.status === 'FAILED') {
    await deps.events.failed({
      paymentId: payment.id,
      bookingId: payment.bookingId,
      reason: payment.failureReason,
    })

    return
  }

  await deps.events.succeeded({
    paymentId: payment.id,
    bookingId: payment.bookingId,
    amount: payment.amount,
    gatewayRef: payment.gatewayRef,
  })
}

async function rejectUnknownPayment(
  deps: PaymentDeps,
  raw: RawNotification,
): Promise<NotificationHandling> {
  // Pembayaran selalu dibuat sebelum pengguna diarahkan ke penyedia, jadi
  // order_id yang tidak dikenal bukan balapan — ia notifikasi untuk sistem lain,
  // atau percobaan penyalahgunaan. Keduanya layak tercatat.
  deps.logger.warn(
    { providerEventId: raw.transactionId, orderId: raw.orderId, security: true },
    'notifikasi menyebut pembayaran yang tidak dikenal',
  )
  await deps.ledger.complete(raw.transactionId, 'rejected_unknown_payment')

  return { kind: 'rejected', why: 'unknown_payment' }
}

async function rejectMismatch(
  deps: PaymentDeps,
  raw: RawNotification,
  payment: Payment,
  notifiedMinor: number,
): Promise<NotificationHandling> {
  // Tingkat error, bukan warn. gross_amount termasuk yang ditandatangani, jadi
  // nilai yang berbeda pada notifikasi yang tanda tangannya sah berarti catatan
  // KITA yang berbeda dari penyedia — soal uang, dan butuh tindakan manusia.
  deps.logger.error(
    {
      providerEventId: raw.transactionId,
      paymentId: payment.id,
      expectedMinor: payment.amount.amountMinor,
      notifiedMinor,
      currency: payment.amount.currency,
    },
    'nilai pada notifikasi berbeda dari nilai pembayaran, notifikasi ditolak',
  )
  await deps.ledger.complete(raw.transactionId, 'rejected_amount_mismatch', payment.id)

  return { kind: 'rejected', why: 'amount_mismatch' }
}
