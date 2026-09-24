import { describe, expect, test } from 'vitest'
import {
  activeFilters,
  formatRupiah,
  parseCriteria,
  searchHref,
  toApiQuery,
  toQueryString,
  type SearchCriteria,
} from './criteria'

/**
 * Kriteria di URL.
 *
 * URL adalah satu-satunya sumber kebenaran, jadi yang dijaga di sini adalah
 * perjalanan bolak-baliknya: apa yang ditulis harus terbaca kembali sama
 * persis, dan apa yang rusak tidak boleh menggagalkan seluruh pencarian.
 */

function criteria(overrides: Partial<SearchCriteria> = {}): SearchCriteria {
  return {
    city: 'Bali',
    checkIn: '2026-11-10',
    checkOut: '2026-11-12',
    guests: 2,
    sort: 'relevansi',
    amenities: [],
    refundableOnly: false,
    breakfastIncluded: false,
    ...overrides,
  }
}

function parse(query: string): SearchCriteria | undefined {
  return parseCriteria(new URLSearchParams(query))
}

describe('perjalanan bolak-balik', () => {
  test('kriteria sederhana kembali utuh', () => {
    const original = criteria()

    expect(parse(toQueryString(original))).toEqual(original)
  })

  test('kriteria dengan seluruh penyaring kembali utuh', () => {
    const original = criteria({
      guests: 5,
      sort: 'harga',
      minStarRating: 4,
      maxTotalMinor: 2_500_000,
      amenities: ['pool', 'wifi'],
      refundableOnly: true,
      breakfastIncluded: true,
    })

    expect(parse(toQueryString(original))).toEqual(original)
  })

  test('nilai bawaan tidak ditulis ke URL', () => {
    // URL yang selalu memuat `&urut=relevansi&refundable=0` menjadi panjang
    // tanpa membawa keterangan apa pun — dan itulah URL yang dibagikan.
    const query = toQueryString(criteria())

    expect(query).toBe('kota=Bali&mulai=2026-11-10&selesai=2026-11-12')
  })

  test('fasilitas ditulis terurut supaya URL-nya stabil', () => {
    const a = toQueryString(criteria({ amenities: ['wifi', 'pool'] }))
    const b = toQueryString(criteria({ amenities: ['pool', 'wifi'] }))

    expect(a).toBe(b)
  })

  test('tautan hasil menunjuk halaman pencarian', () => {
    expect(searchHref(criteria())).toBe('/cari?kota=Bali&mulai=2026-11-10&selesai=2026-11-12')
  })
})

describe('kriteria yang tidak lengkap', () => {
  test.each([
    ['tanpa apa-apa', ''],
    ['tanpa kota', 'mulai=2026-11-10&selesai=2026-11-12'],
    ['tanpa tanggal masuk', 'kota=Bali&selesai=2026-11-12'],
    ['tanpa tanggal keluar', 'kota=Bali&mulai=2026-11-10'],
    ['kota terlalu pendek', 'kota=B&mulai=2026-11-10&selesai=2026-11-12'],
    ['tanggal bukan kalender', 'kota=Bali&mulai=10-11-2026&selesai=2026-11-12'],
  ])('%s menghasilkan undefined', (_label, query) => {
    expect(parse(query)).toBeUndefined()
  })

  test('tanggal keluar sebelum masuk ditolak', () => {
    expect(parse('kota=Bali&mulai=2026-11-12&selesai=2026-11-10')).toBeUndefined()
  })

  test('tanggal keluar sama dengan masuk ditolak', () => {
    expect(parse('kota=Bali&mulai=2026-11-10&selesai=2026-11-10')).toBeUndefined()
  })

  test('menginap lebih dari 30 malam ditolak', () => {
    expect(parse('kota=Bali&mulai=2026-11-10&selesai=2026-12-20')).toBeUndefined()
  })

  test('30 malam tepat diterima', () => {
    expect(parse('kota=Bali&mulai=2026-11-10&selesai=2026-12-10')).toBeDefined()
  })
})

describe('parameter rusak tidak menggagalkan pencarian', () => {
  // Pengguna yang menerima tautan dengan satu parameter salah ketik tetap
  // harus melihat hasil, bukan halaman galat.
  const base = 'kota=Bali&mulai=2026-11-10&selesai=2026-11-12'

  test('jumlah tamu yang bukan angka jatuh ke dua', () => {
    expect(parse(`${base}&tamu=banyak`)?.guests).toBe(2)
  })

  test('jumlah tamu di luar batas dijepit ke bawaan', () => {
    expect(parse(`${base}&tamu=99`)?.guests).toBe(2)
    expect(parse(`${base}&tamu=0`)?.guests).toBe(2)
  })

  test('urutan yang tidak dikenal jatuh ke relevansi', () => {
    expect(parse(`${base}&urut=termurah`)?.sort).toBe('relevansi')
  })

  test('bintang di luar rentang diabaikan', () => {
    expect(parse(`${base}&bintang=9`)?.minStarRating).toBeUndefined()
  })

  test('harga maksimum negatif diabaikan', () => {
    expect(parse(`${base}&maks=-5`)?.maxTotalMinor).toBeUndefined()
  })

  test('kota berspasi berlebih dirapikan', () => {
    expect(parse('kota=  Bali  &mulai=2026-11-10&selesai=2026-11-12')?.city).toBe('Bali')
  })

  test('fasilitas ganda dibuang', () => {
    expect(parse(`${base}&fasilitas=pool,POOL,wifi`)?.amenities).toEqual(['pool', 'wifi'])
  })

  test('fasilitas kosong menghasilkan daftar kosong', () => {
    expect(parse(`${base}&fasilitas=`)?.amenities).toEqual([])
  })
})

describe('bendera boolean', () => {
  const base = 'kota=Bali&mulai=2026-11-10&selesai=2026-11-12'

  test('hanya `1` yang menyalakan', () => {
    expect(parse(`${base}&refundable=1`)?.refundableOnly).toBe(true)
    expect(parse(`${base}&refundable=true`)?.refundableOnly).toBe(false)
    expect(parse(`${base}&refundable=0`)?.refundableOnly).toBe(false)
    expect(parse(base)?.refundableOnly).toBe(false)
  })
})

describe('penerjemahan ke API', () => {
  test('nama parameter Indonesia menjadi nama yang dipahami service', () => {
    const query = toApiQuery(criteria({ sort: 'harga', minStarRating: 4 }))

    expect(query.get('city')).toBe('Bali')
    expect(query.get('checkIn')).toBe('2026-11-10')
    expect(query.get('sort')).toBe('price')
    expect(query.get('minStarRating')).toBe('4')
  })

  test('ketiga urutan diterjemahkan', () => {
    expect(toApiQuery(criteria({ sort: 'relevansi' })).get('sort')).toBe('relevance')
    expect(toApiQuery(criteria({ sort: 'harga' })).get('sort')).toBe('price')
    expect(toApiQuery(criteria({ sort: 'bintang' })).get('sort')).toBe('rating')
  })

  test('bendera ditulis eksplisit, bukan dibiarkan kosong saat mati', () => {
    // Membiarkannya kosong berarti mengandalkan bawaan di dua tempat sekaligus.
    const query = toApiQuery(criteria())

    expect(query.get('refundableOnly')).toBe('false')
    expect(query.get('breakfastIncluded')).toBe('false')
  })

  test('penyaring yang tidak diisi tidak dikirim', () => {
    const query = toApiQuery(criteria())

    expect(query.has('minStarRating')).toBe(false)
    expect(query.has('maxTotalMinor')).toBe(false)
    expect(query.has('amenities')).toBe(false)
  })
})

describe('chip penyaring aktif', () => {
  test('kriteria tanpa penyaring tidak menghasilkan chip', () => {
    expect(activeFilters(criteria())).toEqual([])
  })

  test('setiap penyaring menjadi satu chip', () => {
    const filters = activeFilters(
      criteria({
        minStarRating: 4,
        maxTotalMinor: 2_000_000,
        refundableOnly: true,
        breakfastIncluded: true,
        amenities: ['pool', 'wifi'],
      }),
    )

    expect(filters.map((item) => item.id)).toEqual([
      'bintang',
      'maks',
      'refundable',
      'sarapan',
      'fasilitas:pool',
      'fasilitas:wifi',
    ])
  })

  test('label fasilitas memakai bahasa manusia', () => {
    const filters = activeFilters(criteria({ amenities: ['airport_shuttle'] }))

    expect(filters[0]?.label).toBe('Antar-jemput bandara')
  })

  test('melepas satu chip hanya menghapus penyaringnya sendiri', () => {
    const original = criteria({ minStarRating: 4, refundableOnly: true, amenities: ['pool'] })
    const bintang = activeFilters(original).find((item) => item.id === 'bintang')

    const after = bintang?.remove(original)

    expect(after?.minStarRating).toBeUndefined()
    expect(after?.refundableOnly).toBe(true)
    expect(after?.amenities).toEqual(['pool'])
  })

  test('melepas satu fasilitas menyisakan fasilitas lain', () => {
    const original = criteria({ amenities: ['pool', 'wifi'] })
    const pool = activeFilters(original).find((item) => item.id === 'fasilitas:pool')

    expect(pool?.remove(original).amenities).toEqual(['wifi'])
  })

  test('melepas chip menghasilkan kriteria baru, tidak mengubah yang lama', () => {
    const original = criteria({ minStarRating: 4 })
    const bintang = activeFilters(original).find((item) => item.id === 'bintang')

    bintang?.remove(original)

    expect(original.minStarRating).toBe(4)
  })
})

describe('format rupiah', () => {
  test('tanpa pembagian seratus — satuan terkecil rupiah adalah rupiah', () => {
    // IDR memakai eksponen 0. Menambahkan pembagian seratus akan membuat
    // setiap harga seratus kali lebih kecil, dan terlihat masuk akal.
    expect(formatRupiah(1_332_000)).toContain('1.332.000')
  })

  test('tanpa angka di belakang koma', () => {
    expect(formatRupiah(1_332_000)).not.toContain(',')
  })
})
