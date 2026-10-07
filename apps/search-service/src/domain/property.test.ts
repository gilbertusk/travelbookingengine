import { describe, expect, test } from 'vitest'
import { propertySchema } from './property.js'
import { property } from '../testing/fakes.js'

/**
 * Skema properti.
 *
 * Ini batas antara baris basis data dan sisa sistem. Baris yang tidak lolos
 * DILEWATI saat memuat katalog, bukan menggagalkan seluruh pemuatan — satu
 * properti yang rusak tidak boleh membuat setiap properti dari setiap supplier
 * tampil sebagai belum terpetakan.
 *
 * Yang membuat pelewatan itu aman adalah skema ini benar-benar menolak apa
 * yang seharusnya ditolak.
 */

const VALID = { ...property(), id: '018f0000-0000-7000-8000-000000000001' }

/** Baris tanpa deskripsi — kolomnya memang boleh kosong di basis data. */
const TANPA_DESKRIPSI = Object.fromEntries(
  Object.entries(VALID).filter(([key]) => key !== 'description'),
)

describe('baris yang sah', () => {
  test('diterima apa adanya', () => {
    expect(propertySchema.safeParse(VALID).success).toBe(true)
  })

  test('kontak properti diterima bila ada', () => {
    const parsed = propertySchema.safeParse({
      ...VALID,
      phone: '+62 361 1234',
      email: 'a@b.example',
    })

    expect(parsed.success).toBe(true)
  })

  test('deskripsi boleh tidak ada', () => {
    expect(propertySchema.safeParse(TANPA_DESKRIPSI).success).toBe(true)
  })
})

describe('baris yang ditolak', () => {
  test('pengenal yang bukan uuid', () => {
    expect(propertySchema.safeParse({ ...VALID, id: 'prp_bali_007' }).success).toBe(false)
  })

  test('slug kosong', () => {
    // Slug kosong berarti URL yang tidak dapat dibuka. Lebih baik propertinya
    // tidak muncul daripada muncul dengan tautan yang rusak.
    expect(propertySchema.safeParse({ ...VALID, slug: '' }).success).toBe(false)
  })

  test('zona waktu kosong', () => {
    // Step 25 menghitung tenggat pembatalan dengannya. Kolom kosong yang lolos
    // di sini menjadi pengembalian dana yang keliru berbulan-bulan kemudian.
    expect(propertySchema.safeParse({ ...VALID, timezone: '' }).success).toBe(false)
  })

  test('kontak yang berupa string kosong', () => {
    // Kosong berarti "tidak diketahui", dan itu dinyatakan dengan ketiadaan
    // bidangnya — voucher membedakan keduanya.
    expect(propertySchema.safeParse({ ...VALID, phone: '' }).success).toBe(false)
  })

  test('kode negara yang bukan dua huruf', () => {
    expect(propertySchema.safeParse({ ...VALID, countryCode: 'IDN' }).success).toBe(false)
  })

  test('koordinat di luar rentang bumi', () => {
    expect(propertySchema.safeParse({ ...VALID, latitude: 91 }).success).toBe(false)
    expect(propertySchema.safeParse({ ...VALID, longitude: -181 }).success).toBe(false)
  })

  test('bintang di luar rentang', () => {
    expect(propertySchema.safeParse({ ...VALID, starRating: 7 }).success).toBe(false)
  })
})
