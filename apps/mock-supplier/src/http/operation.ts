import type { Request } from 'express'
import type { SupplierOperation } from '../application/fault-script.js'
import type { SupplierCode } from '../domain/supplier.js'

/**
 * Operasi apa yang sedang diminta, dibaca dari bentuk permintaannya.
 *
 * Kelima supplier menamai operasinya berbeda-beda — itu disengaja sejak
 * Step 04 — jadi tidak ada satu aturan yang berlaku untuk semuanya. Tabel ini
 * satu-satunya tempat perbedaan itu dipetakan untuk penjadwalan kegagalan;
 * rute di http/suppliers/ tetap tidak tahu apa pun tentang kegagalan.
 *
 * Path di sini RELATIF terhadap awalan supplier (`/sky`, `/nova`, ...), karena
 * middleware dipasang dengan `app.use(awalan, ...)`.
 */

interface Route {
  readonly method: string
  readonly path: RegExp
  readonly operation: SupplierOperation
}

const REST_ROUTES: Readonly<Record<Exclude<SupplierCode, 'ORBIT'>, readonly Route[]>> = {
  SKY: [
    { method: 'POST', path: /^\/availability$/, operation: 'search' },
    { method: 'POST', path: /^\/rates\/verify$/, operation: 'rate' },
    { method: 'POST', path: /^\/holds$/, operation: 'hold' },
    { method: 'POST', path: /^\/bookings$/, operation: 'book' },
    { method: 'DELETE', path: /^\/bookings\/[^/]+$/, operation: 'cancel' },
    { method: 'GET', path: /^\/bookings(\/[^/]+)?$/, operation: 'lookup' },
  ],
  NOVA: [
    { method: 'POST', path: /^\/search$/, operation: 'search' },
    { method: 'POST', path: /^\/rate-check$/, operation: 'rate' },
    { method: 'POST', path: /^\/reservations\/hold$/, operation: 'hold' },
    { method: 'POST', path: /^\/reservations\/confirm$/, operation: 'book' },
    { method: 'POST', path: /^\/reservations\/cancel$/, operation: 'cancel' },
    { method: 'GET', path: /^\/reservations\/[^/]+$/, operation: 'lookup' },
  ],
  LUNA: [
    { method: 'POST', path: /^\/availability$/, operation: 'search' },
    { method: 'POST', path: /^\/rate$/, operation: 'rate' },
    { method: 'POST', path: /^\/hold$/, operation: 'hold' },
    { method: 'POST', path: /^\/book$/, operation: 'book' },
    { method: 'POST', path: /^\/void$/, operation: 'cancel' },
    { method: 'GET', path: /^\/bk$/, operation: 'lookup' },
  ],
  ZEPH: [
    { method: 'POST', path: /^\/availability$/, operation: 'search' },
    { method: 'POST', path: /^\/offers\/price$/, operation: 'rate' },
    { method: 'POST', path: /^\/offers\/hold$/, operation: 'hold' },
    { method: 'POST', path: /^\/bookings$/, operation: 'book' },
    { method: 'POST', path: /^\/bookings\/[^/]+\/cancel$/, operation: 'cancel' },
    { method: 'GET', path: /^\/bookings(\/[^/]+)?$/, operation: 'lookup' },
  ],
}

/** ORBIT memakai satu endpoint SOAP; operasinya ada di header SOAPAction. */
const SOAP_ACTIONS: Readonly<Record<string, SupplierOperation>> = {
  Availability: 'search',
  RateCheck: 'rate',
  Hold: 'hold',
  Book: 'book',
  Cancel: 'cancel',
  Retrieve: 'lookup',
}

export function operationOf(code: SupplierCode, req: Request): SupplierOperation | undefined {
  if (code === 'ORBIT') {
    const action = (req.header('soapaction') ?? '').replaceAll('"', '')
    return SOAP_ACTIONS[action]
  }

  return REST_ROUTES[code].find((route) => route.method === req.method && route.path.test(req.path))
    ?.operation
}
