import '@testing-library/jest-dom/vitest'
import { configure } from '@testing-library/dom'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

/**
 * Tenggat bawaan findBy* adalah satu detik.
 *
 * Cukup saat satu berkas uji dijalankan sendirian, tidak cukup saat seluruh
 * paket berjalan bersamaan lewat Turborepo: pengujian yang mengetik dua puluh
 * karakter lalu menunggu validasi Zod melewati satu detik pada mesin yang
 * sedang sibuk, dan gagal karena beban — bukan karena kodenya salah. Kegagalan
 * seperti itu mengajari orang mengabaikan hasil uji.
 */
configure({ asyncUtilTimeout: 5_000 })

/**
 * jsdom tidak mengimplementasikan matchMedia.
 *
 * next-themes memanggilnya untuk membaca preferensi tema sistem, jadi tanpa
 * ini setiap pengujian yang merender ThemeProvider gagal dengan
 * "matchMedia is not a function" — kegagalan yang tidak ada hubungannya
 * dengan hal yang sedang diuji.
 *
 * Jawabannya selalu "tidak cocok", sehingga pengujian berjalan seolah sistem
 * memakai tampilan terang dan hasilnya tidak berubah mengikuti setelan mesin
 * yang menjalankannya.
 */
window.matchMedia = (query: string): MediaQueryList => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: vi.fn(),
  removeListener: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  dispatchEvent: vi.fn(() => false),
})

afterEach(() => {
  cleanup()

  // Dua tempat yang tidak ikut dibersihkan cleanup(): elemen akar, dan
  // penyimpanan peramban. next-themes memakai keduanya, jadi tanpa ini tema
  // yang disetel satu pengujian terbawa ke pengujian berikutnya — dan yang
  // berikutnya gagal karena alasan yang sama sekali tidak terlihat dari
  // isinya sendiri.
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.style.colorScheme = ''
  window.localStorage.clear()
  window.sessionStorage.clear()
})
