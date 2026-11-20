import { requireOperator, success, validate } from '@tbe/shared-kernel'
import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import {
  supplierHealth,
  type HealthDeps,
  type HealthWindow,
} from '../application/supplier-health.js'
import { settingsBody, updateHandler } from './supplier-routes.js'

/**
 * Rute panel operator (Step 27): FR-29 dan FR-31.
 *
 * `requireOperator` dipasang pada awalan, bukan per rute: rute operator baru
 * yang ditambahkan ke berkas ini terlindungi tanpa perlu diingat. Gateway sudah
 * memeriksa peran lebih dulu; pemeriksaan di sini untuk permintaan yang tidak
 * lewat gateway — lihat shared-kernel/src/http/operator.ts.
 */

/** Batas riwayat satu pemesanan. Satu konfirmasi dengan percobaan ulang tidak mendekatinya. */
const MAX_REQUEST_RECORDS = 100

const requestsQuery = validate(
  z.object({ idempotencyKey: z.string().trim().min(1).max(200) }),
  'query',
)

export function createOpsRouter(deps: HealthDeps, window: HealthWindow): Router {
  const router = Router()

  router.use('/ops/suppliers', requireOperator)
  router.get('/ops/suppliers', healthHandler(deps, window))
  router.get('/ops/suppliers/requests', requestsQuery, requestsHandler(deps))
  router.patch('/ops/suppliers/:code', settingsBody, updateHandler(deps))

  return router
}

function healthHandler(deps: HealthDeps, window: HealthWindow): RequestHandler {
  return (_req, res, next) => {
    void supplierHealth(deps, window).then((health) => {
      res.json(success(health))
    }, next)
  }
}

/**
 * Catatan permintaan supplier untuk satu pemesanan, lewat kunci idempotensi
 * yang dikirim booking-service ke supplier. Panel `NEEDS_REVIEW` memakainya:
 * pemesanan yang tidak pasti hanya dapat diputuskan dengan melihat apa yang
 * sebenarnya dikirim dan dijawab, termasuk percobaan yang kehabisan waktu.
 */
function requestsHandler(deps: HealthDeps): RequestHandler {
  return (_req, res, next) => {
    const { idempotencyKey } = requestsQuery.value(res)

    void deps.history.byIdempotencyKey(idempotencyKey, MAX_REQUEST_RECORDS).then((records) => {
      res.json(
        success(
          records.map((record) => ({ ...record, createdAt: record.createdAt.toISOString() })),
        ),
      )
    }, next)
  }
}
