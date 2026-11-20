import { NotFoundError, requireOperator, success, validate } from '@tbe/shared-kernel'
import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import type { BookingDeps } from '../application/ports.js'
import {
  reviewCase,
  reviewQueue,
  type ReviewCase,
  type ReviewDeps,
  type ReviewReader,
} from '../application/review-queue.js'
import type { SagaState } from '../domain/saga-state.js'
import { bookingParams } from './booking-routes.js'
import { bookingView } from './views.js'

/**
 * Rute panel operator (Step 27): antrean NEEDS_REVIEW dan rincian satu
 * pemesanan dengan seluruh konteksnya.
 *
 * Berbeda dari rute pelanggan, bentuk ini MEMBAWA data tamu utama dan
 * pengenal internal (pembayaran, kunci ke supplier, versi). Operator yang
 * memutuskan nasib uang dan kamar seseorang perlu tahu siapa dan mana; dan
 * itulah sebabnya rute ini hanya ada di balik `requireOperator`, pada awalan,
 * sehingga rute baru di berkas ini tidak dapat lupa dilindungi.
 */

const reviewQuery = validate(
  z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
  'query',
)

export function createOpsRouter(deps: BookingDeps, reviews: ReviewReader): Router {
  const router = Router()
  const reviewDeps: ReviewDeps = { reviews, sagas: deps.sagas }

  router.use('/ops/bookings', requireOperator)
  // Sebelum `/:id`, supaya `review` tidak dibaca sebagai pengenal (dan ditolak
  // sebagai bukan UUID).
  router.get('/ops/bookings/review', reviewQuery, (_req, res, next) => {
    void reviewQueue(reviewDeps, reviewQuery.value(res).limit).then((cases) => {
      res.json(success(cases.map((item) => opsCaseView(item, deps.clock.now()))))
    }, next)
  })
  router.get('/ops/bookings/:id', bookingParams, detailHandler(deps, reviewDeps))

  return router
}

function detailHandler(deps: BookingDeps, reviewDeps: ReviewDeps): RequestHandler {
  return (_req, res, next) => {
    void deps.bookings
      .findById(bookingParams.value(res).id)
      .then(async (booking) => {
        if (booking === undefined) throw new NotFoundError('Pemesanan tidak ditemukan')
        return await reviewCase(reviewDeps, booking)
      })
      .then((item) => {
        res.json(success(opsCaseView(item, deps.clock.now())))
      }, next)
  }
}

export function opsCaseView(item: ReviewCase, now: Date) {
  const { booking } = item

  return {
    booking: {
      ...bookingView(booking, now),
      userId: booking.userId,
      version: booking.version,
      createdAt: booking.createdAt.toISOString(),
      updatedAt: booking.updatedAt.toISOString(),
      leadGuest: {
        fullName: booking.guests.leadGuest.fullName,
        email: booking.guests.leadGuest.email,
      },
      paymentId: booking.paymentId ?? null,
      review: booking.review ?? null,
      failureReason: booking.failure?.reason ?? null,
      refundId: booking.refundId ?? null,
    },
    supplierIdempotencyKey: item.supplierIdempotencyKey,
    saga: item.saga === undefined ? null : sagaView(item.saga),
    trail: item.trail.map((entry) => ({
      sequence: entry.sequence,
      type: entry.type,
      occurredAt: entry.occurredAt.toISOString(),
      payload: entry.payload,
    })),
  }
}

function sagaView(saga: SagaState) {
  return {
    phase: saga.phase,
    step: saga.step,
    attempts: saga.attempts,
    lastError: saga.lastError ?? null,
    ...(saga.phase === 'review' ? { compensation: saga.compensation } : {}),
    ...(saga.phase === 'running' ? { stepStatus: saga.stepStatus } : {}),
    updatedAt: saga.updatedAt.toISOString(),
  }
}
