import type { Booking } from '../../domain/booking.js'
import type { BookingChange } from '../../domain/events.js'
import {
  definitionOf,
  directActionOf,
  type DirectCompensation,
  type OutboxCompensation,
  type SagaStep,
} from '../../domain/saga-definition.js'
import {
  beginCompensation,
  compensationAttemptFailed,
  directCompensationDone,
  type CompensationStart,
  type SagaState,
} from '../../domain/saga-state.js'
import { slotOf } from '../hold-slot.js'
import type { BookingDeps, CommitOutcome, ConsumedMessage, OutboundCommand } from '../ports.js'
import { refundPayment, supplierCancel } from './commands.js'

/**
 * Pelaksana kompensasi — generik, dikemudikan tabel di saga-definition.ts.
 *
 * Setiap aksi kompensasi punya SATU implementasi di bawah, dan tipenya
 * `Record` atas seluruh aksi pada rutenya: aksi baru di tabel tanpa
 * implementasi adalah galat compiler, bukan kompensasi yang diam-diam tidak
 * dijalankan.
 */

export interface CompensationContext {
  /** Pemesanan SESUDAH perubahan yang memulai kompensasi. */
  readonly booking: Booking
  /** Booking reference supplier, bila kompensasinya membatalkan pemesanan di supplier. */
  readonly supplierRef?: string
}

export const DIRECT_ACTIONS: Readonly<
  Record<DirectCompensation, (deps: BookingDeps, booking: Booking) => Promise<void>>
> = {
  // Idempoten di dalam skrip Lua: hanya pemanggil yang benar-benar
  // mengeluarkan pemesanan dari slot yang mengembalikan kursinya. Pengulangan
  // setelah proses mati tidak mengembalikan kursi dua kali.
  releaseLocalHold: async (deps, booking) => {
    await deps.holds.release({ bookingId: booking.id, slot: slotOf(booking) })
  },
}

export const OUTBOX_ACTIONS: Readonly<
  Record<OutboxCompensation, (context: CompensationContext) => OutboundCommand>
> = {
  refundPayment: ({ booking }) => {
    // Pemanggil cacat, bukan keadaan yang dapat diantisipasi: rencana
    // kompensasi hanya memuat refund bila langkah pembayaran sudah berhasil.
    if (booking.paymentId === undefined) {
      throw new Error(`refund untuk ${booking.id} diminta, tetapi pemesanannya tanpa pembayaran`)
    }
    const payment = { paymentId: booking.paymentId, amount: booking.price.total }
    return refundPayment(booking, payment, 'supplier_failed')
  },
  cancelSupplierBooking: ({ booking, supplierRef }) => {
    if (supplierRef === undefined) {
      throw new Error(`pembatalan di supplier untuk ${booking.id} diminta tanpa booking reference`)
    }
    return supplierCancel(booking, supplierRef)
  },
}

/**
 * Perintah kompensasi SATU langkah, dibaca dari tabel — untuk langkah yang
 * ternyata berhasil SETELAH saga memutuskan gagal (konfirmasi supplier yang
 * terlambat). Langkah sebelumnya sudah dikompensasi; yang tersisa hanya
 * langkah itu sendiri.
 */
export function compensationCommandFor(
  step: SagaStep,
  context: CompensationContext,
): OutboundCommand {
  const compensation = definitionOf(step).compensation
  if (compensation.kind !== 'run' || compensation.via !== 'outbox') {
    throw new Error(`langkah ${step} tidak punya kompensasi lewat outbox`)
  }

  return OUTBOX_ACTIONS[compensation.action](context)
}

export interface CompensationRequest {
  readonly booking: Booking
  readonly saga: SagaState
  readonly start: Omit<CompensationStart, 'leaseMs' | 'awaitRefundTimeoutMs'>
  /** Transisi pemesanan yang menyertai dimulainya kompensasi — FAILED, CANCELLED. */
  readonly change?: BookingChange
  readonly consumed?: ConsumedMessage
}

/**
 * Memulai kompensasi dalam SATU transaksi — transisi pemesanan, keadaan saga,
 * dan seluruh perintah kompensasi lewat outbox — lalu menjalankan kompensasi
 * langsung yang niatnya sudah tercatat di transaksi itu.
 */
export async function compensate(
  deps: BookingDeps,
  request: CompensationRequest,
): Promise<CommitOutcome> {
  const policy = deps.sagaPolicy
  const after = request.change?.booking ?? request.booking
  const begun = beginCompensation(request.saga, {
    ...request.start,
    leaseMs: policy.leaseMs,
    awaitRefundTimeoutMs: policy.awaitRefundTimeoutMs,
  })
  const outcome = await deps.sagas.commit({
    bookingId: after.id,
    at: request.start.at,
    saga: begun.saga,
    // Refund diminta dari pemesanan SESUDAH perubahan — FAILED membawa
    // pembayarannya. Pembatalan di supplier tidak pernah bagian dari rencana
    // yang dimulai di sini; ia hanya muncul untuk konfirmasi yang terlambat.
    commands: begun.outbox.map((action) => OUTBOX_ACTIONS[action]({ booking: after })),
    ...(request.change === undefined ? {} : { change: request.change }),
    ...(request.consumed === undefined ? {} : { consumed: request.consumed }),
  })

  if (outcome === 'committed') await runDirectCompensations(deps, after, begun.saga)

  return outcome
}

/**
 * Kompensasi langsung, satu per satu, mundur mengikuti penunjuk saga.
 *
 * Niat setiap kompensasi sudah tercatat SEBELUM dijalankan — penunjuk dan
 * sewanya ditulis bersama perpindahan sebelumnya. Proses yang mati di tengah
 * pelepasan meninggalkan saga dengan penunjuk yang sewanya akan habis, dan
 * penyapu saga yang melanjutkannya (sweep-sagas.ts).
 *
 * Kegagalan TIDAK diabaikan: dicatat, dijadwalkan ulang, dan setelah
 * percobaan habis saga diserahkan ke manusia dengan galat tingkat error.
 */
export async function runDirectCompensations(
  deps: BookingDeps,
  booking: Booking,
  saga: SagaState,
): Promise<SagaState> {
  let current = saga

  while (current.phase === 'compensating' && current.compensating !== undefined) {
    const next = await runOne(deps, booking, current, current.compensating)
    const outcome = await deps.sagas.commit({
      bookingId: booking.id,
      at: next.updatedAt,
      saga: next,
    })

    // Pihak lain — pemulih yang mengira proses ini mati — sudah melanjutkan
    // saga ini. Kompensasinya idempoten; yang tersisa milik pihak itu.
    if (outcome !== 'committed') return current
    current = next
    // Percobaan yang gagal dijadwalkan ulang lewat sewanya; penyapu saga yang
    // mengulangnya setelah jeda, bukan putaran ini tanpa jeda.
    if (next.phase === 'compensating' && next.attempts > 0) return current
  }

  return current
}

async function runOne(
  deps: BookingDeps,
  booking: Booking,
  saga: SagaState,
  step: SagaStep,
): Promise<SagaState> {
  const action = DIRECT_ACTIONS[directActionOf(step)]

  try {
    await action(deps, booking)
    return directCompensationDone(saga, deps.clock.now(), deps.sagaPolicy.leaseMs)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const policy = deps.sagaPolicy.compensationRetry
    const failed = compensationAttemptFailed(saga, deps.clock.now(), message, policy)
    logFailure(deps, { bookingId: booking.id, step, error, failed })
    return failed
  }
}

function logFailure(
  deps: BookingDeps,
  entry: { bookingId: string; step: SagaStep; error: unknown; failed: SagaState },
): void {
  const context = { bookingId: entry.bookingId, step: entry.step, err: entry.error }

  if (entry.failed.phase === 'review') {
    deps.logger.error(
      { ...context, attempts: entry.failed.attempts },
      'kompensasi gagal setelah seluruh percobaan, saga diserahkan ke peninjauan manusia',
    )
    return
  }
  deps.logger.warn(
    { ...context, attempts: entry.failed.attempts },
    'kompensasi gagal, dijadwalkan ulang',
  )
}
