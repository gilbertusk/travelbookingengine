import { ValidationError, success, validate } from '@tbe/shared-kernel'
import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import { listBookings, MAX_PAGE_SIZE } from '../application/list-bookings.js'
import type { BookingDeps } from '../application/ports.js'
import { BOOKING_GROUPS } from '../domain/booking-groups.js'
import { identity } from './identity.js'
import { listItemView } from './views.js'

/**
 * `GET /bookings?group=upcoming|past|cancelled&cursor=&limit=` — daftar
 * pemesanan pengguna (Step 26, FR-25), satu kelompok per permintaan.
 */

const listQuery = validate(
  z.object({
    group: z.enum(BOOKING_GROUPS).default('upcoming'),
    cursor: z.string().max(20).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(10),
  }),
  'query',
)

export function createBookingListRouter(deps: BookingDeps): Router {
  const router = Router()

  router.get('/bookings', identity, listQuery, listHandler(deps))

  return router
}

function listHandler(deps: BookingDeps): RequestHandler {
  return (_req, res, next) => {
    const query = listQuery.value(res)

    void listBookings(deps, { userId: identity.value(res), ...query }).then((result) => {
      if (result.kind === 'invalid_cursor') {
        next(new ValidationError('Penunjuk halaman tidak sah'))
        return
      }
      res.json(
        success({
          items: result.items.map((item) => listItemView(item.booking, item.propertyName)),
          nextCursor: result.nextCursor,
        }),
      )
    }, next)
  }
}
