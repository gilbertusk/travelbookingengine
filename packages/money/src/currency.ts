import { z } from 'zod'
import type { DineroCurrency } from 'dinero.js'

/**
 * Mata uang yang didukung.
 *
 * Dua saja — keputusan Q2. Tidak ada abstraksi untuk mata uang yang belum
 * dibutuhkan: tabel kurs bergeneralisasi dan pemuat mata uang dinamis yang
 * dibuat "untuk nanti" hanya menambah tempat kesalahan pada sistem yang
 * seluruh uangnya hanya dua jenis.
 */
export const CURRENCIES = ['IDR', 'USD'] as const
export type Currency = (typeof CURRENCIES)[number]

export const currencySchema = z.enum(CURRENCIES)

/**
 * Banyak angka desimal pada satuan terkecil.
 *
 * **IDR dipakai dengan eksponen 0, bukan 2.**
 *
 * ISO 4217 mencantumkan IDR dengan dua desimal karena sen rupiah pernah ada.
 * Sen sudah tidak beredar sejak lama: tidak ada harga hotel yang berakhir
 * dengan sen, tidak ada mesin pembayaran yang menerimanya, dan tidak ada
 * pengguna yang pernah melihatnya.
 *
 * Memakai eksponen 2 berarti setiap angka rupiah di seluruh sistem menjadi
 * ambigu — `2893400` bisa berarti Rp 2.893.400 atau Rp 28.934,00 — dan
 * ambiguitas itu baru ketahuan saat ada yang membandingkan tagihan. Dengan
 * eksponen 0, satuan terkecil rupiah adalah rupiah itu sendiri, persis seperti
 * yang dipakai supplier dan yang dilihat pengguna.
 *
 * Konsekuensinya: pembulatan IDR terjadi pada rupiah penuh, sementara USD pada
 * sen. Keduanya diuji terpisah.
 */
export const EXPONENT: Readonly<Record<Currency, number>> = { IDR: 0, USD: 2 }

/**
 * Definisi untuk dinero.js.
 *
 * Ditulis sendiri, tidak diimpor dari `dinero.js`, karena IDR bawaannya
 * memakai eksponen 2. Mengimpornya akan membuat seluruh perhitungan rupiah
 * meleset seratus kali lipat tanpa satu pun galat yang terlihat.
 */
export const DINERO_CURRENCY: Readonly<Record<Currency, DineroCurrency<number>>> = {
  IDR: { code: 'IDR', base: 10, exponent: EXPONENT.IDR },
  USD: { code: 'USD', base: 10, exponent: EXPONENT.USD },
}

/** Berapa satuan terkecil dalam satu satuan utama. */
export function minorUnitsPerMajor(currency: Currency): number {
  return 10 ** EXPONENT[currency]
}

export function isCurrency(value: string): value is Currency {
  return (CURRENCIES as readonly string[]).includes(value)
}
