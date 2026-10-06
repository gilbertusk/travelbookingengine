import type { Booking, BookingStatusView } from '@/features/booking/types'

/**
 * Data contoh fitur pemesanan untuk uji. Bentuknya mengikuti jawaban
 * booking-service; yang berbeda per uji ditimpa lewat `overrides`.
 */

const IDR = (amountMinor: number) => ({ amountMinor, currency: 'IDR' as const })

/** Pemesanan contoh, PRICE_CHECKED dengan harga terverifikasi. */
export function sampleBooking(overrides: Partial<Booking> = {}): Booking {
  return {
    id: '018f0000-0000-7000-8000-000000000001',
    status: 'PRICE_CHECKED',
    supplier: 'SKY',
    propertyId: 'sky-123',
    city: 'Bali',
    ratePlanRef: 'SKY-RP-1',
    checkIn: '2026-11-10',
    checkOut: '2026-11-12',
    guests: 2,
    price: {
      total: IDR(2_442_000),
      lineItems: [
        { kind: 'base', description: 'Harga kamar', amount: IDR(2_000_000) },
        { kind: 'tax', description: 'PPN 11%', amount: IDR(242_000) },
      ],
    },
    heldUntil: null,
    priceCheck: { outcome: 'unchanged', price: IDR(2_442_000) },
    serverTime: '2026-10-06T10:00:00.000Z',
    ...overrides,
  }
}

/** Status contoh: PAID, saga sedang mengonfirmasi ke supplier. */
export function sampleStatus(overrides: Partial<BookingStatusView> = {}): BookingStatusView {
  return {
    id: '018f0000-0000-7000-8000-000000000001',
    status: 'PAID',
    isFinal: false,
    version: 4,
    updatedAt: '2026-10-06T10:00:00.000Z',
    heldUntil: '2026-10-06T10:15:00.000Z',
    supplierRef: null,
    failureReason: null,
    refund: null,
    saga: { phase: 'running', step: 'confirmSupplier' },
    serverTime: '2026-10-06T10:00:01.000Z',
    ...overrides,
  }
}
