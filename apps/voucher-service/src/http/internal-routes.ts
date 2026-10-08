import { NotFoundError, validate } from '@tbe/shared-kernel'
import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import type { VoucherDeps } from '../application/ports.js'
import { voucherDocument } from '../application/voucher-access.js'

/**
 * Antarmuka antar-service (Step 24).
 *
 * Awalan `/internal` TIDAK dirutekan api-gateway, sama seperti rute internal
 * booking-service dan katalog search-service. Pemakainya notification-service,
 * yang melampirkan voucher pada surel konfirmasi.
 *
 * Voucher yang belum terbit dijawab 404 BERAMPLOP `NOT_FOUND`. Pembacanya
 * membedakan amplop itu dari 404 telanjang: yang pertama berarti "belum ada,
 * tunggu", yang kedua berarti rute atau alamatnya salah.
 */

const documentParams = validate(z.object({ bookingId: z.uuid() }), 'params')

export function createInternalRouter(deps: VoucherDeps): Router {
  const router = Router()

  router.get('/internal/vouchers/:bookingId/document', documentParams, documentHandler(deps))

  return router
}

function documentHandler(deps: VoucherDeps): RequestHandler {
  return (_req, res, next) => {
    void voucherDocument(deps, documentParams.value(res).bookingId).then((pdf) => {
      if (pdf === undefined) {
        next(new NotFoundError('Voucher tidak ditemukan'))
        return
      }
      res.setHeader('content-type', 'application/pdf')
      res.setHeader('cache-control', 'no-store')
      res.end(Buffer.from(pdf))
    }, next)
  }
}
