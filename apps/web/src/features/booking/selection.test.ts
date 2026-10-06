import { describe, expect, test } from 'vitest'
import { parseCriteria } from '@/features/search/criteria'
import type { Offer } from '@/features/search/types'
import {
  bookingHref,
  bookingStatusHref,
  findOffer,
  parseSelection,
  selectionKey,
  withBooking,
} from './selection'

const IDR = (amountMinor: number) => ({ amountMinor, currency: 'IDR' as const })

const OFFER: Offer = {
  supplier: 'SKY',
  supplierPropertyId: 'sky-1',
  supplierRatePlanId: 'SKY-RP-1',
  roomTypeName: 'Deluxe',
  ratePlanName: 'Termasuk sarapan',
  refundable: true,
  breakfastIncluded: true,
  unitsLeft: 4,
  total: IDR(2_442_000),
  base: IDR(2_000_000),
  markup: IDR(200_000),
  tax: IDR(242_000),
  taxName: 'PPN 11%',
}

const criteria = () => {
  const parsed = parseCriteria(
    new URLSearchParams('kota=Bali&mulai=2026-11-10&selesai=2026-11-12&tamu=3'),
  )
  if (parsed === undefined) throw new Error('kriteria contoh tidak sah')
  return parsed
}

describe('pilihan kamar lewat URL', () => {
  test('pulang-pergi: dari halaman properti ke alur pemesanan', () => {
    const href = bookingHref('padma-legian', OFFER, criteria())
    const selection = parseSelection(new URLSearchParams(href.split('?')[1]))

    expect(href.startsWith('/bookings/pesan?')).toBe(true)
    expect(selection).toMatchObject({
      slug: 'padma-legian',
      supplier: 'SKY',
      ratePlanId: 'SKY-RP-1',
      criteria: { city: 'Bali', checkIn: '2026-11-10', checkOut: '2026-11-12', guests: 3 },
    })
    // Harga TIDAK dibawa URL; diambil ulang dari pencarian.
    expect(href).not.toContain('2442000')
  })

  test('URL yang tidak lengkap tidak menjadi pilihan', () => {
    expect(parseSelection(new URLSearchParams('kota=Bali&mulai=2026-11-10'))).toBeUndefined()
    expect(
      parseSelection(
        new URLSearchParams(
          'kota=Bali&mulai=2026-11-10&selesai=2026-11-12&properti=x&penyedia=SKY',
        ),
      ),
    ).toBeUndefined()
  })

  test('pemesanan yang sudah dibuat ikut di URL, untuk dilanjutkan setelah dimuat ulang', () => {
    const href = bookingHref('padma-legian', OFFER, criteria())
    const params = new URLSearchParams(href.split('?')[1])
    const resumed = parseSelection(new URLSearchParams(withBooking(params, 'b-9').split('?')[1]))

    expect(resumed?.bookingId).toBe('b-9')
  })

  test('kunci pilihan: kamar dan masa inap, bukan urutan parameter', () => {
    const selection = parseSelection(
      new URLSearchParams(bookingHref('padma-legian', OFFER, criteria()).split('?')[1]),
    )
    if (selection === undefined) throw new Error('pilihan tidak terurai')

    expect(selectionKey(selection)).toBe('SKY|SKY-RP-1|2026-11-10|2026-11-12|3')
  })

  test('tawaran ditemukan menurut penyedia dan rate plan', () => {
    expect(findOffer([OFFER], { supplier: 'SKY', ratePlanId: 'SKY-RP-1' })).toBe(OFFER)
    expect(findOffer([OFFER], { supplier: 'NOVA', ratePlanId: 'SKY-RP-1' })).toBeUndefined()
  })

  test('halaman status, dengan atau tanpa hasil pembayaran', () => {
    expect(bookingStatusHref('b-1')).toBe('/bookings/b-1')
    expect(bookingStatusHref('b-1', 'selesai')).toBe('/bookings/b-1?bayar=selesai')
  })
})
