import { describe, expect, test } from 'vitest'
import { confirmedSource, PROPERTY } from '../testing/fakes.js'
import {
  cancellationText,
  composeVoucher,
  issuedAtLabel,
  nightsBetween,
  NOT_RECORDED,
  stayDateLabel,
} from './voucher-content.js'
import { issueLatencyMs } from './voucher.js'

const ISSUED_AT = new Date('2026-10-07T03:00:04.000Z')

function compose(...args: Parameters<typeof confirmedSource>) {
  const result = composeVoucher(confirmedSource(...args), PROPERTY, ISSUED_AT)
  if (!result.ok) throw new Error(`ditolak: ${result.error.kind}`)
  return result.value
}

describe('isi voucher', () => {
  test('memuat seluruh field wajib FR-24 sebagai teks', () => {
    const content = compose()

    expect(content).toMatchObject({
      bookingReference: 'SKY-BK-7F3A21',
      property: {
        name: 'Padma Bali Boutique Hotel',
        address: 'Jalan Melati No. 12, Bali',
        phone: '+62 361 4021',
        email: 'reservasi@padma-bali.example',
      },
      stay: {
        checkIn: 'Selasa, 10 November 2026',
        checkOut: 'Kamis, 12 November 2026',
        nights: '2 malam',
      },
      roomType: 'Deluxe King',
      ratePlan: 'Refundable with Breakfast (termasuk sarapan)',
      guest: { name: 'Sari Wulandari', count: '2 tamu' },
    })
  })

  test('rincian harga diformat rupiah, baris demi baris, dengan totalnya', () => {
    const { price } = compose()

    expect(price.lines.map((line) => line.label)).toEqual([
      'Malam 10 Nov 2026',
      'Malam 11 Nov 2026',
      'PPN 11%',
    ])
    expect(price.total.replace(/\s/g, ' ')).toBe('Rp 2.442.000')
  })

  test('booking reference dirapikan dari spasi', () => {
    expect(compose({ supplierRef: '  SKY-1  ' }).bookingReference).toBe('SKY-1')
  })

  test('tarif tanpa sarapan disebutkan terang', () => {
    const terms = { ...confirmedSource().terms!, breakfastIncluded: false }

    expect(compose({ terms }).ratePlan).toBe('Refundable with Breakfast (tanpa sarapan)')
  })

  test('pemesanan sebelum Step 23 menyebut ketentuan tidak tercatat, bukan menebaknya', () => {
    const content = compose({ terms: null })

    expect(content.roomType).toBe(NOT_RECORDED)
    expect(content.ratePlan).toBe(NOT_RECORDED)
    expect(content.cancellationPolicy).toContain(NOT_RECORDED)
  })

  test('properti tanpa kontak menyebut ketiadaannya, bukan string kosong', () => {
    const withoutContact = { name: PROPERTY.name, address: PROPERTY.address, city: PROPERTY.city }
    const result = composeVoucher(confirmedSource(), withoutContact, ISSUED_AT)

    expect(result.ok && result.value.property.phone).toContain('Tidak tersedia')
    expect(result.ok && result.value.property.email).toContain('Tidak tersedia')
  })

  test('alamat tanpa kota tidak berakhir dengan koma', () => {
    const result = composeVoucher(confirmedSource(), { ...PROPERTY, city: '' }, ISSUED_AT)

    expect(result.ok && result.value.property.address).toBe('Jalan Melati No. 12')
  })
})

describe('voucher yang tidak boleh terbit', () => {
  test('pemesanan yang belum CONFIRMED', () => {
    const result = composeVoucher(confirmedSource({ status: 'PAID' }), PROPERTY, ISSUED_AT)

    expect(result).toEqual({ ok: false, error: { kind: 'not_confirmed', status: 'PAID' } })
  })

  test.each([null, '   '])('booking reference supplier %j', (supplierRef) => {
    const result = composeVoucher(confirmedSource({ supplierRef }), PROPERTY, ISSUED_AT)

    expect(result).toEqual({ ok: false, error: { kind: 'missing_reference' } })
  })
})

describe('kebijakan pembatalan', () => {
  test.each([
    [{ refundable: false } as const, 'Tidak dapat dibatalkan dengan pengembalian dana.'],
    [{ refundable: true } as const, 'Tenggat pembatalan gratis tidak disebutkan penyedia'],
    [{ refundable: true, freeCancellationDays: 3 } as const, 'sampai 3 hari sebelum tanggal masuk'],
  ])('%j', (policy, expected) => {
    expect(cancellationText(policy)).toContain(expected)
  })
})

describe('tanggal dan waktu', () => {
  test('tanggal menginap tidak bergeser di zona barat Greenwich', () => {
    // Diuji dengan tanggal di awal bulan: pergeseran satu hari ke belakang
    // langsung terlihat sebagai bulan yang berbeda.
    expect(stayDateLabel('2026-12-01')).toBe('Selasa, 1 Desember 2026')
  })

  test('jumlah malam dihitung dari tanggal kalender', () => {
    expect(nightsBetween('2026-10-24', '2026-10-27')).toBe(3)
  })

  test('waktu terbit menyebut zonanya', () => {
    expect(issuedAtLabel(ISSUED_AT)).toMatch(/7 Oktober 2026.*03.00 UTC$/)
  })

  test('latensi tidak pernah negatif', () => {
    const at = new Date('2026-10-07T03:00:00.000Z')

    expect(issueLatencyMs({ issuedAt: at, confirmedAt: new Date(at.getTime() + 1_000) })).toBe(0)
  })
})
