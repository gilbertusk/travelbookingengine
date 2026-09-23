import { NextRequest } from 'next/server'
import { describe, expect, test } from 'vitest'
import { proxy } from './proxy'

/**
 * Perlindungan rute privat.
 *
 * Yang dijaga di sini hanya pengalihan halaman. Keputusan akses yang
 * sebenarnya tetap di gateway — tetapi rute privat yang lupa didaftarkan di
 * sini akan sempat dirender untuk pengunjung yang belum masuk, dan itu
 * terlihat seperti kebocoran meski datanya tidak pernah ikut.
 */

const BASE = 'https://lintang.test'

function request(path: string, options: { readonly withSession?: boolean } = {}): NextRequest {
  const headers = new Headers()
  if (options.withSession === true) headers.set('cookie', 'tbe_refresh=token-apa-saja')

  return new NextRequest(`${BASE}${path}`, { headers })
}

function redirectTarget(path: string, options?: { readonly withSession?: boolean }): string | null {
  const location = proxy(request(path, options)).headers.get('location')

  return location === null ? null : location.replace(BASE, '')
}

describe('rute privat', () => {
  test('mengalihkan pengunjung tanpa sesi ke halaman masuk', () => {
    expect(redirectTarget('/bookings')).toBe('/masuk?lanjut=%2Fbookings')
  })

  test('membawa serta tujuan semula supaya pengguna tidak terdampar di beranda', () => {
    expect(redirectTarget('/bookings/bkg_123')).toBe('/masuk?lanjut=%2Fbookings%2Fbkg_123')
  })

  test('membiarkan pemilik sesi melanjutkan', () => {
    expect(redirectTarget('/bookings', { withSession: true })).toBeNull()
  })

  test('tidak menghalangi rute publik', () => {
    for (const path of ['/', '/cari', '/design-system']) {
      expect(redirectTarget(path)).toBeNull()
    }
  })
})

describe('halaman khusus tamu', () => {
  test('mengalihkan pengguna yang sudah masuk keluar dari halaman masuk dan daftar', () => {
    expect(redirectTarget('/masuk', { withSession: true })).toBe('/')
    expect(redirectTarget('/daftar', { withSession: true })).toBe('/')
  })

  test('membiarkan tamu membuka halaman masuk dan daftar', () => {
    expect(redirectTarget('/masuk')).toBeNull()
    expect(redirectTarget('/daftar')).toBeNull()
  })
})
