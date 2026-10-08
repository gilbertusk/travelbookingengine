import { runWithCorrelation } from '@tbe/shared-kernel'
import type { BookingSnapshot } from '../domain/booking-snapshot.js'
import {
  RATE_LIMIT_WINDOW_MS,
  RETRY_DELAYS_MS,
  VOUCHER_NOT_READY,
  afterTransientFailure,
  isDeliverableAddress,
  rateDecision,
  recipientKey,
} from '../domain/delivery.js'
import type { ClaimedNotification, NotificationContext } from '../domain/notification.js'
import { compose, type ComposeRefusal, type EmailContent } from '../domain/templates/compose.js'
import type { Attachment, NotificationDeps, Settlement } from './ports.js'

/**
 * Penghantar: mengambil pemberitahuan yang jatuh tempo, menyusun surelnya,
 * mengirimnya, dan mencatat hasilnya.
 *
 * Penghantar adalah SATU-SATUNYA tempat surel dikirim, apa pun pintu masuk
 * pemberitahuannya. Consumer Kafka dan RabbitMQ hanya mencatat; mereka selesai
 * dalam satu tulisan ke basis data, sehingga server SMTP yang mati tidak
 * pernah menahan partisi Kafka maupun antrian perintah (NFR-05). Percobaan
 * ulang dan dead letter juga hidup di sini, di basis data service ini, karena
 * hanya di sini kegagalan pengiriman terjadi.
 *
 * Tidak ada yang dilempar keluar dari `deliverDue` karena kegagalan kirim.
 * Yang masih dapat dilempar hanyalah galat basis data service ini sendiri —
 * dan itu ditangkap pembungkus pekerjaan berkala, lalu dicoba putaran
 * berikutnya. Sewa baris memastikan pemberitahuan yang sedang dikerjakan saat
 * itu diambil lagi.
 */

/** Jumlah pemberitahuan yang dikerjakan. */
export async function deliverDue(deps: NotificationDeps): Promise<number> {
  const { batchSize, leaseMs } = deps.policy

  // Satu per satu dan berurutan. Sewa diambil tepat sebelum barisnya
  // dikerjakan, sehingga tidak ada baris yang sewanya habis sambil menunggu
  // giliran. Berurutan juga karena pembatasan laju menghitung surel yang
  // sudah terkirim: dua surel ke penerima yang sama harus saling melihat.
  for (let done = 0; done < batchSize; done += 1) {
    const notification = await deps.notifications.claimNext(deps.clock.now(), leaseMs)
    if (notification === undefined) return done
    await deliverOne(deps, notification)
  }

  return batchSize
}

/**
 * Satu pemberitahuan, di dalam correlationId pemicunya: log pengiriman dan
 * panggilan ke booking-service tersambung ke alur pemesanan yang
 * menyebabkannya, bukan ke pesan apa pun yang kebetulan membangunkan
 * penghantar.
 */
async function deliverOne(
  deps: NotificationDeps,
  notification: ClaimedNotification,
): Promise<void> {
  await runWithCorrelation(notification.correlationId, async () => {
    await deliverInContext(deps, notification)
  })
}

async function deliverInContext(
  deps: NotificationDeps,
  notification: ClaimedNotification,
): Promise<void> {
  const settlement = await settle(deps, notification)
  const isRecorded = await deps.notifications.settle(notification, settlement, deps.clock.now())
  if (!isRecorded) {
    deps.logger.warn(
      { notificationId: notification.id, outcome: settlement.kind },
      'sewa pemberitahuan sudah habis dan diambil alih; hasil ini tidak dicatat',
    )
    return
  }
  deps.metrics.delivered(notification.type, settlement.kind)
  report(deps, notification, settlement)
}

/** Hasil satu percobaan sebelum kegagalan sementara diterjemahkan ke jenjang. */
type Attempt = Settlement | { readonly kind: 'transient'; readonly code: string }

async function settle(
  deps: NotificationDeps,
  notification: ClaimedNotification,
): Promise<Settlement> {
  // Baris yang isinya tidak dapat diurai tidak akan pernah dapat dikirim.
  if (notification.context === null) {
    return { kind: 'dead', attempts: notification.attempts, reason: 'invalid_context' }
  }
  // Sewa yang habis berulang kali berarti penghantarnya mati SETIAP kali
  // mengerjakan baris ini. Mencobanya lagi hanya mematikan penghantar lagi.
  if (notification.attempts > RETRY_DELAYS_MS.length) {
    return { kind: 'dead', attempts: notification.attempts, reason: 'lease_exhausted' }
  }

  const attempt = await attemptSafely(deps, { ...notification, context: notification.context })
  if (attempt.kind !== 'transient') return attempt

  const outcome = afterTransientFailure(notification.attempts, deps.clock.now())
  return outcome.kind === 'retry'
    ? {
        kind: 'retry',
        attempts: outcome.attempts,
        nextAttemptAt: outcome.nextAttemptAt,
        reason: attempt.code,
      }
    : { kind: 'dead', attempts: outcome.attempts, reason: attempt.code }
}

/**
 * Galat yang dilempar adapter — booking-service atau voucher-service yang
 * tidak menjawab, soket SMTP yang putus — adalah kegagalan sementara. Ia
 * diterjemahkan menjadi percobaan ulang, dan rinciannya masuk log; pesannya
 * TIDAK masuk basis data, karena dapat memuat alamat penerima.
 */
/** Pemberitahuan yang isinya sudah terurai. */
type Readable = ClaimedNotification & { readonly context: NotificationContext }

async function attemptSafely(deps: NotificationDeps, notification: Readable): Promise<Attempt> {
  try {
    return await attempt(deps, notification)
  } catch (error) {
    deps.logger.warn(
      { err: error, notificationId: notification.id, bookingId: notification.bookingId },
      'percobaan kirim pemberitahuan gagal sementara',
    )
    return { kind: 'transient', code: 'upstream_error' }
  }
}

async function attempt(deps: NotificationDeps, notification: Readable): Promise<Attempt> {
  const lookup = await deps.bookings.notificationSource(notification.bookingId)
  if (lookup.kind === 'not_found') return { kind: 'skipped', reason: 'booking_not_found' }

  const { booking } = lookup
  const content = compose(notification.context, booking)
  if (!content.ok) return { kind: 'skipped', reason: refusalReason(content.error) }

  const address = booking.leadGuest.email
  const key = recipientKey(address, deps.policy.recipientKeySecret)
  if (!isDeliverableAddress(address)) {
    return { kind: 'failed', reason: 'invalid_address', recipientKey: key }
  }

  const now = deps.clock.now()
  const sentRecently = await deps.notifications.sentToRecipientSince(
    key,
    new Date(now.getTime() - RATE_LIMIT_WINDOW_MS),
  )
  const rate = rateDecision(sentRecently, deps.policy.ratePerHour, now)
  if (rate.kind === 'defer') return { kind: 'deferred', until: rate.until, recipientKey: key }

  return await send(deps, notification, { booking, content: content.value, recipientKey: key })
}

interface Ready {
  readonly booking: BookingSnapshot
  readonly content: EmailContent
  readonly recipientKey: string
}

async function send(
  deps: NotificationDeps,
  notification: ClaimedNotification,
  ready: Ready,
): Promise<Attempt> {
  const attachments = await attachmentsFor(deps, notification)
  if (attachments === undefined) return { kind: 'transient', code: VOUCHER_NOT_READY }

  const result = await deps.sender.send({
    to: ready.booking.leadGuest.email,
    ...ready.content,
    attachments,
  })

  switch (result.kind) {
    case 'sent':
      return {
        kind: 'sent',
        at: deps.clock.now(),
        recipientKey: ready.recipientKey,
        userId: ready.booking.userId,
      }
    case 'permanent':
      return { kind: 'failed', reason: result.code, recipientKey: ready.recipientKey }
    case 'transient':
      return result
  }
}

const VOUCHER_FILENAME = 'e-voucher.pdf'

/**
 * Lampiran surel. `undefined` berarti lampiran wajib belum ada: surel
 * konfirmasi menunggu vouchernya alih-alih terkirim tanpa voucher. Penantian
 * itu biasanya singkat — `voucher.issued` memajukan jadwalnya begitu voucher
 * terbit.
 */
async function attachmentsFor(
  deps: NotificationDeps,
  notification: ClaimedNotification,
): Promise<readonly Attachment[] | undefined> {
  if (notification.type !== 'booking_confirmed') return []

  const pdf = await deps.vouchers.document(notification.bookingId)
  return pdf === undefined
    ? undefined
    : [{ filename: VOUCHER_FILENAME, contentType: 'application/pdf', content: pdf }]
}

function refusalReason(refusal: ComposeRefusal): string {
  return refusal.kind === 'outdated' ? `outdated:${refusal.status}` : refusal.kind
}

/**
 * Log per hasil. Dead letter dan kegagalan permanen bertingkat `error`: ada
 * pengguna yang tidak menerima kabar tentang pemesanannya — untuk surel
 * kegagalan, itu kabar tentang uangnya — dan seseorang harus menindaklanjuti.
 */
function report(
  deps: NotificationDeps,
  notification: ClaimedNotification,
  settlement: Settlement,
): void {
  const fields = {
    notificationId: notification.id,
    bookingId: notification.bookingId,
    type: notification.type,
    outcome: settlement.kind,
    ...('reason' in settlement ? { reason: settlement.reason } : {}),
  }

  switch (settlement.kind) {
    case 'dead':
      deps.logger.error(
        fields,
        'pemberitahuan masuk dead letter: percobaan habis, butuh tindak lanjut manusia',
      )
      return
    case 'failed':
      deps.logger.error(fields, 'pemberitahuan gagal permanen dan tidak dicoba ulang')
      return
    case 'retry':
    case 'deferred':
      deps.logger.warn(fields, 'pemberitahuan ditunda')
      return
    case 'sent':
    case 'skipped':
      deps.logger.info(fields, 'pemberitahuan selesai')
      return
  }
}
