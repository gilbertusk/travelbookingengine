import { toJson } from '@tbe/money'
import { NotFoundError, success } from '@tbe/shared-kernel'
import { Router, type RequestHandler } from 'express'
import type { BookingDeps } from '../application/ports.js'
import type { Booking } from '../domain/booking.js'
import { bookingParams } from './booking-routes.js'

/**
 * Antarmuka antar-service (Step 23, Step 24).
 *
 * Awalan `/internal` TIDAK dirutekan api-gateway — daftar rutenya hanya
 * memuat awalan publik — sehingga rute ini hanya dapat dicapai dari jaringan
 * service. Tidak ada identitas pengguna di sini: pemanggilnya service, dan
 * pemeriksaan kepemilikan dikerjakan pemanggil itu terhadap `userId` di
 * jawaban (voucher-service, sebelum menerbitkan URL unduhan).
 */

export function createInternalRouter(deps: BookingDeps): Router {
  const router = Router()

  router.get(
    '/internal/bookings/:id/voucher-source',
    bookingParams,
    viewHandler(deps, voucherSourceView),
  )
  router.get(
    '/internal/bookings/:id/notification-source',
    bookingParams,
    viewHandler(deps, notificationSourceView),
  )

  return router
}

function viewHandler(deps: BookingDeps, view: (booking: Booking) => object): RequestHandler {
  return (_req, res, next) => {
    void deps.bookings.findById(bookingParams.value(res).id).then((booking) => {
      if (booking === undefined) {
        next(new NotFoundError('Pemesanan tidak ditemukan'))
        return
      }
      res.json(success(view(booking)))
    }, next)
  }
}

/**
 * Bahan e-voucher.
 *
 * Berbeda dari `bookingView`, bentuk ini MEMBAWA nama tamu utama: voucher
 * wajib menyebutnya, dan pembacanya service lain di jaringan internal, bukan
 * peramban. Surel tamu tetap tidak disertakan — voucher tidak memerlukannya.
 *
 * `confirmedAt` adalah waktu transisi ke CONFIRMED. CONFIRMED final (Step 16),
 * jadi `updatedAt` pemesanan CONFIRMED tidak pernah bergeser lagi; inilah titik
 * awal pengukuran M7.
 */
export function voucherSourceView(booking: Booking) {
  const isConfirmed = booking.status === 'CONFIRMED'

  return {
    id: booking.id,
    userId: booking.userId,
    status: booking.status,
    supplier: booking.supplier,
    supplierRef: booking.supplierRef ?? null,
    confirmedAt: isConfirmed ? booking.updatedAt.toISOString() : null,
    propertyId: booking.propertyId,
    checkIn: booking.stay.checkIn,
    checkOut: booking.stay.checkOut,
    guests: { count: booking.guests.count, leadGuestName: booking.guests.leadGuest.fullName },
    price: {
      total: toJson(booking.price.total),
      lineItems: booking.price.lineItems.map((item) => ({
        kind: item.kind,
        description: item.description,
        amount: toJson(item.amount),
      })),
    },
    terms: booking.terms ?? null,
  }
}

/**
 * Bahan surel pemberitahuan (Step 24).
 *
 * Satu-satunya bentuk yang MEMBAWA surel tamu utama: alamat itu tujuan
 * pemberitahuan, dan pemesanan adalah satu-satunya tempat ia tercatat —
 * peristiwa Kafka sengaja tidak membawanya. Selebihnya hanya yang disebut
 * surel: rincian harga, ketentuan lengkap, dan pengenal properti supplier
 * tidak ikut, karena setiap bidang tambahan adalah data yang harus dijaga
 * (NFR-15) tanpa ada yang membacanya.
 */
export function notificationSourceView(booking: Booking) {
  return {
    id: booking.id,
    userId: booking.userId,
    status: booking.status,
    supplierRef: booking.supplierRef ?? null,
    checkIn: booking.stay.checkIn,
    checkOut: booking.stay.checkOut,
    guestCount: booking.guests.count,
    leadGuest: {
      fullName: booking.guests.leadGuest.fullName,
      email: booking.guests.leadGuest.email,
    },
    roomTypeName: booking.terms?.roomTypeName ?? null,
    total: toJson(booking.price.total),
  }
}
