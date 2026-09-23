import type { OperationFailure } from '../domain/booking.js'

/**
 * Pemetaan kegagalan operasi ke status HTTP.
 *
 * Statusnya sama untuk semua supplier, tetapi bentuk badan responsnya berbeda
 * — sama seperti di dunia nyata, di mana semua orang sepakat soal 404 dan
 * tidak seorang pun sepakat soal isi pesannya.
 */
export function mapFailure(failure: OperationFailure): readonly [number, string] {
  switch (failure.kind) {
    case 'invalid_request':
      return [400, 'INVALID_REQUEST']
    case 'not_found':
      return [404, 'NOT_FOUND']
    case 'sold_out':
      return [409, 'SOLD_OUT']
    case 'hold_expired':
      return [409, 'HOLD_EXPIRED']
    case 'price_changed':
      return [409, 'PRICE_CHANGED']
    case 'already_cancelled':
      return [409, 'ALREADY_CANCELLED']
  }
}
