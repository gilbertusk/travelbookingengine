import { v7 as uuidv7 } from 'uuid'
import type { Clock, IdFactory } from '../application/ports.js'

/**
 * Jam dan pembuat pengenal yang sesungguhnya.
 *
 * Keduanya dijadikan port bukan demi kemungkinan menggantinya, melainkan supaya
 * use case dapat diuji tanpa waktu nyata dan tanpa pengenal acak — uji yang
 * bergantung pada `Date.now()` akan lulus hari ini dan gagal pada pergantian
 * tahun, dan uji yang tidak dapat menyebut pengenal yang akan dihasilkan tidak
 * dapat memeriksa apa pun tentangnya.
 */

export const systemClock: Clock = {
  now: () => new Date(),
}

/**
 * UUID versi 7: berawalan cap waktu, jadi terurut menurut waktu pembuatan.
 *
 * Penting untuk kolom yang menjadi kunci utama di Postgres — UUID v4 yang acak
 * menyebar penulisan ke seluruh indeks B-tree, sementara v7 menambahkannya di
 * ujung. Pada tabel pembayaran yang hanya bertambah, perbedaannya nyata.
 */
export const uuidFactory: IdFactory = {
  next: () => uuidv7(),
}
