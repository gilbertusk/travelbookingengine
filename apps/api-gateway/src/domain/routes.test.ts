import { describe, expect, test } from 'vitest'
import {
  identityHeaders,
  isClientForgedHeader,
  isHopByHop,
  stripForgedHeaders,
  USER_EMAIL_HEADER,
  USER_ID_HEADER,
} from './identity.js'
import { isAllowedMethod, matchRoute, ROUTES } from './routes.js'

describe('tabel rute', () => {
  test('setiap rute menyatakan kebutuhan autentikasi dan kelas batas lajunya', () => {
    // Rute yang lupa ditandai butuh autentikasi akan terlihat di sini, bukan
    // setelah seseorang membaca data pengguna lain.
    for (const route of ROUTES) {
      expect(typeof route.requiresAuth).toBe('boolean')
      expect(route.rateLimit.length).toBeGreaterThan(0)
      expect(route.timeoutMs).toBeGreaterThan(0)
    }
  })

  test('rute pemesanan, pembayaran, dan voucher semuanya terlindungi', () => {
    const terbuka = ROUTES.filter(
      (route) =>
        !route.requiresAuth &&
        ['booking', 'payment', 'voucher'].includes(route.service) &&
        route.prefix !== '/payments/webhook',
    )

    expect(terbuka).toEqual([])
  })

  test('endpoint kredensial memakai kelas batas laju paling ketat', () => {
    for (const path of ['/auth/login', '/auth/register', '/auth/refresh']) {
      expect(matchRoute('POST', path)?.rateLimit).toBe('sensitive')
    }
  })

  test('mencocokkan awalan terpanjang, bukan yang pertama ditemukan', () => {
    // Bergantung pada urutan daftar berarti menyisipkan satu rute baru di
    // tempat yang salah diam-diam mengubah perilaku rute lain.
    expect(matchRoute('POST', '/auth/login')?.rateLimit).toBe('sensitive')
    expect(matchRoute('GET', '/auth/me')?.rateLimit).toBe('public')
    expect(matchRoute('GET', '/bookings/stream/bkg_1')?.streaming).toBe(true)
    expect(matchRoute('GET', '/bookings/bkg_1')?.streaming).toBeUndefined()
  })

  test('awalan hanya cocok pada batas segmen path', () => {
    expect(matchRoute('GET', '/search')).toBeDefined()
    expect(matchRoute('GET', '/search/suggest')).toBeDefined()
    expect(matchRoute('GET', '/searching-for-trouble')).toBeUndefined()
  })

  test('menghormati batasan metode per rute', () => {
    expect(matchRoute('POST', '/auth/login')?.methods).toEqual(['POST'])
    // GET ke /auth/login jatuh ke rute /auth yang lebih umum, bukan hilang
    expect(matchRoute('GET', '/auth/login')?.prefix).toBe('/auth')
  })

  test('path yang tidak dikenal tidak cocok dengan rute mana pun', () => {
    expect(matchRoute('GET', '/tidak-ada')).toBeUndefined()
    expect(matchRoute('GET', '/metrics')).toBeUndefined()
  })

  test('rute streaming punya batas waktu jauh lebih panjang', () => {
    const streaming = matchRoute('GET', '/bookings/stream/bkg_1')
    const biasa = matchRoute('GET', '/bookings/bkg_1')

    expect(streaming?.timeoutMs).toBeGreaterThan(biasa?.timeoutMs ?? 0)
  })

  test('pencarian punya batas waktu lebih ketat daripada rute biasa', () => {
    expect(matchRoute('GET', '/search')?.timeoutMs).toBeLessThan(
      matchRoute('GET', '/bookings')?.timeoutMs ?? 0,
    )
  })

  test('hanya metode yang dipakai sistem ini diizinkan', () => {
    expect(isAllowedMethod('GET')).toBe(true)
    expect(isAllowedMethod('post')).toBe(true)
    // TRACE memantulkan permintaan apa adanya, termasuk header.
    expect(isAllowedMethod('TRACE')).toBe(false)
    expect(isAllowedMethod('TRACK')).toBe(false)
    expect(isAllowedMethod('CONNECT')).toBe(false)
  })
})

describe('header identitas', () => {
  test('mengenali seluruh header berawalan internal sebagai palsu', () => {
    // Menyebut nama satu per satu berarti setiap header internal baru
    // menambah celah sampai seseorang ingat memperbarui daftarnya.
    expect(isClientForgedHeader(USER_ID_HEADER)).toBe(true)
    expect(isClientForgedHeader('X-TBE-User-Id')).toBe(true)
    expect(isClientForgedHeader('x-tbe-sesuatu-yang-belum-ada')).toBe(true)
    expect(isClientForgedHeader('authorization')).toBe(false)
  })

  test('membuang header identitas yang dikirim klien', () => {
    const dibersihkan = stripForgedHeaders({
      authorization: 'Bearer abc',
      [USER_ID_HEADER]: 'id-korban',
      [USER_EMAIL_HEADER]: 'korban@example.com',
      'content-type': 'application/json',
    })

    expect(dibersihkan).toEqual({
      authorization: 'Bearer abc',
      'content-type': 'application/json',
    })
  })

  test('membangun header identitas dari identitas terverifikasi', () => {
    expect(identityHeaders({ userId: 'u1', email: 'a@b.com' })).toEqual({
      [USER_ID_HEADER]: 'u1',
      [USER_EMAIL_HEADER]: 'a@b.com',
    })
  })

  test('mengenali header yang hanya berlaku untuk satu lompatan', () => {
    // Meneruskan content-length lama menghasilkan respons terpotong atau
    // menggantung.
    for (const name of ['connection', 'Transfer-Encoding', 'content-length', 'host', 'upgrade']) {
      expect(isHopByHop(name)).toBe(true)
    }

    expect(isHopByHop('content-type')).toBe(false)
  })
})
