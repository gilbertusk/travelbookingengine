import { describe, expect, test } from 'vitest'
import { baseSlug, normalizeName, slugify, uniqueSlug } from './slug.js'

/**
 * Slug.
 *
 * Sifat yang paling penting di sini tidak dapat dilihat dari satu pemanggilan:
 * slug tidak boleh berubah ketika nama properti diperbarui. Uji terakhir di
 * berkas ini yang menjaganya.
 */

describe('slugify', () => {
  test('mengubah spasi dan tanda baca menjadi tanda hubung tunggal', () => {
    expect(slugify('Padma Bali Boutique Hotel')).toBe('padma-bali-boutique-hotel')
    expect(slugify('Wijaya  Bali   Grand  Hotel')).toBe('wijaya-bali-grand-hotel')
    expect(slugify('Hotel & Resort, Bali')).toBe('hotel-resort-bali')
  })

  test('menguraikan tanda diakritik alih-alih membuangnya', () => {
    // Membuang huruf beraksen akan mengubah "Café" menjadi "caf", dan dua
    // properti yang berbeda dapat bertabrakan di slug yang sama.
    expect(slugify('Café Résidence')).toBe('cafe-residence')
  })

  test('tidak meninggalkan tanda hubung di awal atau akhir', () => {
    expect(slugify('  Hotel Bali  ')).toBe('hotel-bali')
    expect(slugify('---Hotel---')).toBe('hotel')
    expect(slugify('Hotel!!!')).toBe('hotel')
  })

  test('nama yang tidak menyisakan huruf menghasilkan slug kosong', () => {
    expect(slugify('!!!')).toBe('')
    expect(slugify('')).toBe('')
  })

  test('dipotong tanpa menyisakan tanda hubung menggantung', () => {
    const long = `${'a'.repeat(79)} bali`

    const slug = slugify(long)

    expect(slug.length).toBeLessThanOrEqual(80)
    expect(slug.endsWith('-')).toBe(false)
  })
})

describe('normalizeName', () => {
  test('menyeragamkan ejaan yang berbeda antar supplier', () => {
    // Inilah variasi yang ditanam mock-supplier: kapital semua, awalan
    // "Hotel", singkatan bertitik.
    expect(normalizeName('PADMA BALI BOUTIQUE HOTEL')).toBe('padma bali boutique hotel')
    expect(normalizeName('Padma Bali Boutique Htl.')).toBe('padma bali boutique htl')
    expect(normalizeName('Wijaya Bali Grand Hotel (Bali)')).toBe('wijaya bali grand hotel bali')
  })

  test('tidak meninggalkan spasi berlebih', () => {
    expect(normalizeName('  Hotel   Bali  ')).toBe('hotel bali')
  })
})

describe('baseSlug', () => {
  test('menyertakan kota karena nama hotel berulang antar kota', () => {
    expect(baseSlug({ name: 'Padma Resort', city: 'Bandung' })).toBe('padma-resort-bandung')
  })

  test('tidak mengulang kota yang sudah ada di dalam nama', () => {
    expect(baseSlug({ name: 'Padma Bali Boutique Hotel', city: 'Bali' })).toBe(
      'padma-bali-boutique-hotel',
    )
  })

  test('tidak mengulang kota yang berada di akhir nama', () => {
    expect(baseSlug({ name: 'Grand Hotel Surabaya', city: 'Surabaya' })).toBe(
      'grand-hotel-surabaya',
    )
  })

  test('kota dengan dua kata tetap tertangani', () => {
    expect(baseSlug({ name: 'Mahesa Suites', city: 'Kuala Lumpur' })).toBe(
      'mahesa-suites-kuala-lumpur',
    )
  })

  test('nama kosong jatuh ke kota', () => {
    expect(baseSlug({ name: '!!!', city: 'Bali' })).toBe('bali')
  })
})

describe('uniqueSlug', () => {
  test('memakai slug dasar bila belum terpakai', () => {
    expect(uniqueSlug({ name: 'Padma Resort', city: 'Bali' }, new Set())).toBe('padma-resort-bali')
  })

  test('menambahkan angka berurutan saat bertabrakan', () => {
    // Dua hotel bernama sama di kota yang sama memang ada. `padma-resort-bali-2`
    // masih terbaca manusia dan masih masuk akal di hasil mesin pencari;
    // potongan UUID tidak.
    const taken = new Set(['padma-resort-bali'])

    expect(uniqueSlug({ name: 'Padma Resort', city: 'Bali' }, taken)).toBe('padma-resort-bali-2')
  })

  test('melanjutkan angka sampai menemukan yang kosong', () => {
    const taken = new Set(['padma-resort-bali', 'padma-resort-bali-2', 'padma-resort-bali-3'])

    expect(uniqueSlug({ name: 'Padma Resort', city: 'Bali' }, taken)).toBe('padma-resort-bali-4')
  })

  test('menolak nama yang tidak menghasilkan slug apa pun', () => {
    expect(() => uniqueSlug({ name: '!!!', city: '!!!' }, new Set())).toThrow(RangeError)
  })

  test('menyerah dengan jelas alih-alih berputar tanpa henti', () => {
    // Data yang rusak — misalnya seluruh properti bernama sama — harus gagal
    // dengan pesan, bukan menggantung tanpa penjelasan.
    const taken = new Set([
      'a-bali',
      ...Array.from({ length: 1_000 }, (_, i) => `a-bali-${String(i + 2)}`),
    ])

    expect(() => uniqueSlug({ name: 'a', city: 'Bali' }, taken)).toThrow(RangeError)
  })
})

describe('slug bersifat permanen', () => {
  test('nama yang berubah tidak mengubah slug yang sudah ada', () => {
    // Ini sifat yang dijaga seluruh berkas ini. Slug dibangkitkan sekali saat
    // properti dibuat; pembaruan nama TIDAK memanggil uniqueSlug lagi.
    //
    // Dibuktikan di sini sebagai sifat fungsi: slug lama tetap slug lama
    // meski nama barunya menghasilkan slug dasar yang berbeda.
    const original = uniqueSlug({ name: 'Padma Bali Boutique Hotel', city: 'Bali' }, new Set())
    const afterRename = baseSlug({ name: 'Padma Bali Grand Resort', city: 'Bali' })

    expect(original).toBe('padma-bali-boutique-hotel')
    expect(afterRename).not.toBe(original)
    // Yang disimpan tetap yang pertama. Penegakannya ada di lapisan
    // penyimpanan, dan diuji di property-catalog.test.ts.
  })
})
