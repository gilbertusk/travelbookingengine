import type { Money } from '@tbe/money'
import {
  onRefundFailed,
  onSupplierCancelFailed,
  onSupplierCancelled,
} from '../application/cancellation/on-replies.js'
import { cancellationRefundRequestId } from '../application/cancellation/commands.js'
import {
  previewCancellation,
  requestCancellation,
  type CancellationResult,
  type PreviewResult,
} from '../application/cancellation/request.js'
import type { Reaction } from '../application/saga/reaction.js'
import type { Booking } from '../domain/booking.js'
import { USER } from './fakes.js'
import {
  PAYMENT_ID,
  SUPPLIER_REF,
  sagaWorld,
  type SagaWorld,
  type WorldOptions,
} from './saga-world.js'

/**
 * Dunia uji saga pembatalan (Step 25): dunia saga Step 19 — use case,
 * repository, unit kerja, dan outbox sungguhan di atas basis data palsuan yang
 * meniru transaksi — ditambah jawaban supplier-service dan payment-service
 * atas pembatalan.
 */

export interface CancellationWorld extends SagaWorld {
  /** Pemesanan CONFIRMED, lewat price check, hold, pembayaran, dan konfirmasi sungguhan. */
  confirmed(key?: string): Promise<Booking>
  preview(booking: Booking): Promise<PreviewResult>
  /** Membatalkan dengan nilai yang DILIHAT di pratinjau, kecuali dinyatakan lain. */
  cancel(booking: Booking, expectedRefund?: Money): Promise<CancellationResult>
  supplierCancelled(booking: Booking, options?: { eventId?: string }): Promise<Reaction>
  supplierCancelFailed(booking: Booking, outcome?: 'refused' | 'uncertain'): Promise<Reaction>
  refundFailed(booking: Booking, options?: { refundRequestId?: string }): Promise<Reaction>
  /** Muatan perintah di outbox untuk satu pemesanan. */
  commands(bookingId: string, type: string): readonly unknown[]
}

type Replies = Pick<
  CancellationWorld,
  'supplierCancelled' | 'supplierCancelFailed' | 'refundFailed'
>

export function cancellationWorld(options: WorldOptions = {}): CancellationWorld {
  const world = sagaWorld(options)
  const { deps } = world

  const preview = async (booking: Booking): Promise<PreviewResult> =>
    await previewCancellation(deps, { userId: USER, bookingId: booking.id })

  return {
    ...world,
    ...repliesFor(world),
    confirmed: async (key) => {
      const paid = await world.paid(key)
      await world.supplierConfirmed(paid)
      return await world.booking(paid.id)
    },
    preview,
    cancel: async (booking, expectedRefund) => {
      const seen = await preview(booking)
      const refund = expectedRefund ?? (seen.kind === 'quoted' ? seen.quote.refund : undefined)
      if (refund === undefined) throw new Error(`pratinjau tanpa nilai: ${seen.kind}`)

      return await requestCancellation(deps, {
        userId: USER,
        bookingId: booking.id,
        expectedRefund: refund,
      })
    },
    commands: (bookingId, type) =>
      world
        .outbox()
        .filter((row) => row.bookingId === bookingId && row.messageType === type)
        .map((row) => row.payload),
  }
}

/** Jawaban supplier-service dan payment-service atas pembatalan. */
function repliesFor(world: SagaWorld): Replies {
  const { deps } = world
  let replies = 0
  const fresh = (label: string): string => {
    replies += 1
    return world.eventId(`${label}${String(replies)}`)
  }

  return {
    supplierCancelled: async (booking, options = {}) =>
      await onSupplierCancelled(deps, {
        eventId: options.eventId ?? fresh('c'),
        bookingId: booking.id,
        supplierRef: SUPPLIER_REF,
      }),
    supplierCancelFailed: async (booking, outcome = 'refused') =>
      await onSupplierCancelFailed(deps, {
        eventId: fresh('f'),
        bookingId: booking.id,
        supplierRef: SUPPLIER_REF,
        outcome,
        reason: outcome === 'refused' ? 'upstream_error:409' : 'dead_letter:exhausted',
      }),
    refundFailed: async (booking, options = {}) => {
      const current = await world.booking(booking.id)
      return await onRefundFailed(deps, {
        eventId: fresh('r'),
        bookingId: booking.id,
        paymentId: PAYMENT_ID,
        refundRequestId:
          options.refundRequestId ?? cancellationRefundRequestId(booking.id, PAYMENT_ID),
        amount: current.cancellationRequest?.refund ?? current.price.total,
        reason: 'gateway_rejected',
      })
    },
  }
}
