import { AppError, NotFoundError, success, validate } from '@tbe/shared-kernel'
import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import type { VoucherDeps } from '../application/ports.js'
import { voucherLink, type AccessResult } from '../application/voucher-access.js'
import { identity } from './identity.js'

/**
 * Antarmuka HTTP voucher, dilayani lewat api-gateway di awalan /vouchers.
 *
 * Identitas diperiksa SEBELUM parameter: permintaan tanpa identitas dijawab
 * 401, bukan 400 yang membocorkan bentuk rute kepada siapa pun.
 */

const voucherParams = validate(z.object({ bookingId: z.uuid() }), 'params')

export function createVoucherRouter(deps: VoucherDeps): Router {
  const router = Router()

  router.get('/vouchers/:bookingId', identity, voucherParams, linkHandler(deps))

  return router
}

function linkHandler(deps: VoucherDeps): RequestHandler {
  return (_req, res, next) => {
    const request = { userId: identity.value(res), bookingId: voucherParams.value(res).bookingId }

    void voucherLink(deps, request).then((result) => {
      if (result.kind !== 'link') {
        next(errorFor(result))
        return
      }
      // URL bertanda tangan adalah kredensial berumur pendek. Tidak boleh
      // disimpan cache mana pun di antara service ini dan peramban.
      res.setHeader('cache-control', 'no-store')
      res.json(success({ url: result.url, expiresAt: result.expiresAt.toISOString() }))
    }, next)
  }
}

function errorFor(result: Exclude<AccessResult, { kind: 'link' }>): AppError {
  switch (result.kind) {
    case 'not_found':
      return new NotFoundError('Voucher tidak ditemukan')
    case 'not_confirmed':
      return new AppError({
        code: 'BOOKING_NOT_CONFIRMED',
        httpStatus: 409,
        message:
          'Pemesanan ini belum terkonfirmasi, jadi belum punya voucher. ' +
          'Voucher terbit otomatis setelah penyedia mengonfirmasi pemesanan.',
        details: { status: result.status },
      })
    case 'pending':
      return new AppError({
        code: 'VOUCHER_NOT_READY',
        httpStatus: 409,
        message: 'Voucher sedang diterbitkan. Silakan coba lagi dalam beberapa detik.',
      })
  }
}
