import { describe, expect, test } from 'vitest'
import { safeRedirect } from './safe-redirect'

/**
 * Tujuan setelah masuk.
 *
 * Nilainya datang dari URL, jadi dikendalikan siapa pun yang membuat
 * tautannya. Tanpa pemeriksaan, `/masuk?lanjut=https://situs-palsu` melempar
 * pengguna ke situs lain tepat setelah ia berhasil masuk — momen ketika ia
 * paling siap memasukkan kredensial sekali lagi.
 */
describe('pengalihan setelah masuk', () => {
  test('menerima path internal', () => {
    expect(safeRedirect('/bookings')).toBe('/bookings')
    expect(safeRedirect('/bookings/bkg_1?tab=rincian')).toBe('/bookings/bkg_1?tab=rincian')
  })

  test('menolak alamat absolut ke situs lain', () => {
    expect(safeRedirect('https://situs-palsu.test/masuk')).toBe('/')
    expect(safeRedirect('http://situs-palsu.test')).toBe('/')
  })

  test('menolak bentuk yang dibaca peramban sebagai host lain', () => {
    // '//situs-lain' mewarisi skema halaman sekarang dan tetap keluar dari
    // domain kita; '/\situs-lain' dinormalisasi peramban menjadi hal yang sama.
    expect(safeRedirect('//situs-palsu.test')).toBe('/')
    expect(safeRedirect('/\\situs-palsu.test')).toBe('/')
  })

  test('menolak skema yang dapat mengeksekusi kode', () => {
    expect(safeRedirect('javascript:alert(1)')).toBe('/')
    expect(safeRedirect('data:text/html,<script>alert(1)</script>')).toBe('/')
  })

  test('tanpa tujuan, kembali ke beranda', () => {
    expect(safeRedirect(null)).toBe('/')
    expect(safeRedirect('')).toBe('/')
  })
})
