import { describe, expect, test } from 'vitest'
import {
  cityTag,
  normalize,
  resultCacheKey,
  supplierCacheKey,
  validateCriteria,
  type SearchCriteria,
} from './criteria.js'

/**
 * Kriteria dan kunci cache.
 *
 * Dua sifat yang saling berlawanan dijaga di sini: kriteria yang SETARA harus
 * menghasilkan kunci yang sama, dan kriteria yang BERBEDA tidak boleh
 * bertabrakan. Menguji hanya yang pertama akan lulus dengan kunci konstan.
 */

const TODAY = '2026-09-24'

function criteria(overrides: Partial<SearchCriteria> = {}): SearchCriteria {
  return {
    city: 'Bali',
    checkIn: '2026-11-10',
    checkOut: '2026-11-12',
    guests: 2,
    sort: 'relevance',
    amenities: [],
    refundableOnly: false,
    breakfastIncluded: false,
    ...overrides,
  }
}

describe('normalisasi', () => {
  test('kota dikecilkan hurufnya dan spasinya dirapikan', () => {
    expect(normalize(criteria({ city: '  Kuala   Lumpur ' })).city).toBe('kuala lumpur')
  })

  test('fasilitas diurutkan dan dibuang gandanya', () => {
    // `['wifi','pool']` dan `['pool','wifi']` adalah penyaring yang sama.
    // Tanpa pengurutan, keduanya menjadi dua kunci cache yang berbeda.
    expect(normalize(criteria({ amenities: ['WiFi', 'pool', 'wifi ', 'POOL'] })).amenities).toEqual(
      ['pool', 'wifi'],
    )
  })

  test('bidang lain tidak ikut berubah', () => {
    const original = criteria({ guests: 4, minStarRating: 3 })

    expect(normalize(original).guests).toBe(4)
    expect(normalize(original).minStarRating).toBe(3)
  })
})

describe('kriteria setara menghasilkan kunci yang sama', () => {
  test('huruf besar-kecil kota', () => {
    expect(resultCacheKey(criteria({ city: 'BALI' }))).toBe(
      resultCacheKey(criteria({ city: 'bali' })),
    )
  })

  test('spasi berlebih', () => {
    expect(resultCacheKey(criteria({ city: ' Bali ' }))).toBe(resultCacheKey(criteria()))
  })

  test('urutan fasilitas', () => {
    expect(resultCacheKey(criteria({ amenities: ['pool', 'wifi'] }))).toBe(
      resultCacheKey(criteria({ amenities: ['wifi', 'pool'] })),
    )
  })

  test('urutan bidang saat objeknya disusun', () => {
    // `JSON.stringify` mempertahankan urutan penyisipan; urutan bidang
    // bergantung pada cara pemanggil menyusunnya, dan itu bukan sesuatu yang
    // boleh memengaruhi cache.
    const a: SearchCriteria = {
      city: 'bali',
      checkIn: '2026-11-10',
      checkOut: '2026-11-12',
      guests: 2,
      sort: 'relevance',
      amenities: [],
      refundableOnly: false,
      breakfastIncluded: false,
    }
    const b: SearchCriteria = {
      breakfastIncluded: false,
      refundableOnly: false,
      amenities: [],
      sort: 'relevance',
      guests: 2,
      checkOut: '2026-11-12',
      checkIn: '2026-11-10',
      city: 'bali',
    }

    expect(resultCacheKey(a)).toBe(resultCacheKey(b))
  })

  test('penyaring opsional yang tidak diisi', () => {
    expect(resultCacheKey({ ...criteria(), minStarRating: undefined })).toBe(
      resultCacheKey(criteria()),
    )
  })
})

describe('kriteria berbeda tidak bertabrakan', () => {
  const base = resultCacheKey(criteria())

  test.each([
    ['kota', criteria({ city: 'Bandung' })],
    ['tanggal masuk', criteria({ checkIn: '2026-11-11' })],
    ['tanggal keluar', criteria({ checkOut: '2026-11-13' })],
    ['jumlah tamu', criteria({ guests: 4 })],
    ['urutan', criteria({ sort: 'price' })],
    ['bintang minimum', criteria({ minStarRating: 4 })],
    ['harga maksimum', criteria({ maxTotalMinor: 2_000_000 })],
    ['fasilitas', criteria({ amenities: ['pool'] })],
    ['hanya refundable', criteria({ refundableOnly: true })],
    ['sarapan', criteria({ breakfastIncluded: true })],
  ])('%s', (_label, other) => {
    expect(resultCacheKey(other)).not.toBe(base)
  })
})

describe('kunci cache per supplier', () => {
  test('mengabaikan penyaring dan urutan', () => {
    // Penyaring diterapkan pada HASIL, bukan pada permintaan ke supplier.
    // Menyertakannya akan memecah entri cache per kombinasi penyaring
    // sementara jawaban supplier-nya sama persis — dan itu yang membuat
    // jawaban supplier lambat berguna pada pencarian berikutnya.
    const withFilters = criteria({
      sort: 'price',
      minStarRating: 5,
      amenities: ['pool'],
      refundableOnly: true,
    })

    expect(supplierCacheKey('SKY', withFilters)).toBe(supplierCacheKey('SKY', criteria()))
  })

  test('tetap membedakan kota, tanggal, dan jumlah tamu', () => {
    const base = supplierCacheKey('SKY', criteria())

    expect(supplierCacheKey('SKY', criteria({ city: 'Bandung' }))).not.toBe(base)
    expect(supplierCacheKey('SKY', criteria({ checkIn: '2026-11-11' }))).not.toBe(base)
    expect(supplierCacheKey('SKY', criteria({ guests: 4 }))).not.toBe(base)
  })

  test('supplier berbeda adalah kunci berbeda', () => {
    expect(supplierCacheKey('SKY', criteria())).not.toBe(supplierCacheKey('NOVA', criteria()))
  })
})

describe('penanda kota untuk pembatalan', () => {
  test('sama untuk seluruh pencarian di kota yang sama', () => {
    expect(cityTag(criteria({ checkIn: '2026-12-01', checkOut: '2026-12-05' }))).toBe(
      cityTag(criteria()),
    )
  })

  test('berbeda antar kota', () => {
    expect(cityTag(criteria({ city: 'Bandung' }))).not.toBe(cityTag(criteria()))
  })
})

describe('validasi yang tidak dapat dinyatakan skema', () => {
  test('tanggal keluar harus setelah tanggal masuk', () => {
    expect(validateCriteria(criteria({ checkOut: '2026-11-10' }), TODAY)).toBe(
      'checkout_not_after_checkin',
    )
    expect(validateCriteria(criteria({ checkOut: '2026-11-09' }), TODAY)).toBe(
      'checkout_not_after_checkin',
    )
  })

  test('menginap lebih dari 30 malam ditolak', () => {
    // Di atas ini hampir pasti salah ketik, dan permintaannya akan memaksa
    // lima supplier menghitung ketersediaan untuk rentang yang tidak ada
    // seorang pun benar-benar memesannya.
    expect(validateCriteria(criteria({ checkOut: '2026-12-11' }), TODAY)).toBe('stay_too_long')
    expect(validateCriteria(criteria({ checkOut: '2026-12-10' }), TODAY)).toBeUndefined()
  })

  test('tanggal lampau ditolak', () => {
    expect(
      validateCriteria(criteria({ checkIn: '2026-09-23', checkOut: '2026-09-25' }), TODAY),
    ).toBe('check_in_in_past')
  })

  test('menginap yang dimulai hari ini diterima', () => {
    // Pemesanan hari-H adalah kasus yang sah dan justru yang paling mendesak.
    expect(
      validateCriteria(criteria({ checkIn: TODAY, checkOut: '2026-09-25' }), TODAY),
    ).toBeUndefined()
  })

  test('terlalu jauh ke depan ditolak', () => {
    expect(
      validateCriteria(criteria({ checkIn: '2028-12-01', checkOut: '2028-12-03' }), TODAY),
    ).toBe('too_far_ahead')
  })

  test('kriteria yang wajar diterima', () => {
    expect(validateCriteria(criteria(), TODAY)).toBeUndefined()
  })
})
