import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Verifikasi tanda tangan notifikasi Midtrans.
 *
 * Midtrans menandatangani notifikasinya dengan
 * `SHA-512(order_id + status_code + gross_amount + server_key)`. Empat bahan
 * itu digabung TANPA pemisah, dan urutannya tidak dapat ditukar — karena itu
 * ada satu uji jawaban-diketahui pada signature.test.ts yang membekukan satu
 * nilai hash sungguhan. Uji yang hanya membandingkan fungsi ini dengan dirinya
 * sendiri akan lulus meski urutannya tertukar.
 *
 * Bahwa `gross_amount` termasuk yang ditandatangani punya akibat penting:
 * penyerang tidak dapat menaikkan nilai pembayaran tanpa membatalkan tanda
 * tangannya. Karena itu nilai yang tidak cocok pada notifikasi yang tanda
 * tangannya SAH berarti catatan kita yang berbeda — bukan pemalsuan — dan
 * ditangani sebagai `amount_mismatch` di payment.ts, bukan sebagai penolakan
 * keamanan.
 *
 * `node:crypto` diimpor di lapisan domain dengan sengaja. Ia fungsi murni dari
 * masukannya — hash dan pembandingan, tanpa I/O, tanpa keadaan, tanpa
 * konfigurasi — jadi aturan "domain tanpa pustaka pihak ketiga selain utilitas
 * murni" pada CONVENTIONS.md bagian 1 terpenuhi. Menaruhnya di infrastructure
 * justru akan memindahkan keputusan keamanan ke lapisan yang tidak diuji
 * sebagai keputusan.
 */

export interface SignatureInput {
  readonly orderId: string
  readonly statusCode: string
  /**
   * gross_amount MENTAH, apa adanya dari penyedia — "1250000.00", bukan hasil
   * penguraiannya. Memformat ulang angkanya akan mengubah bahan tanda tangan
   * dan membuat seluruh notifikasi yang sah ditolak, dan kegagalan itu terlihat
   * persis seperti serangan.
   */
  readonly grossAmount: string
  readonly serverKey: string
}

export function expectedSignature(input: SignatureInput): string {
  const material = `${input.orderId}${input.statusCode}${input.grossAmount}${input.serverKey}`

  return createHash('sha512').update(material, 'utf8').digest('hex')
}

/**
 * Perbandingan tanda tangan dengan waktu tetap.
 *
 * `===` pada string berhenti pada karakter pertama yang berbeda, dan lamanya
 * perbandingan itu dapat diukur. Dengan cukup banyak percobaan, selisih waktu
 * itu membocorkan tanda tangan yang benar satu karakter demi satu karakter —
 * tanpa perlu mengetahui server key sama sekali.
 *
 * Perbedaan keduanya TIDAK dapat dibedakan dari perilaku: keduanya menjawab
 * benar atau salah pada masukan yang sama. Karena itu penjagaannya bersifat
 * struktural — lihat uji "perbandingan tanda tangan tidak memakai ===" pada
 * signature.test.ts, yang membaca berkas ini. Uji pengukuran waktu sudah
 * dipertimbangkan dan ditolak: ia rapuh pada mesin CI yang terbagi, dan uji
 * keamanan yang kadang gagal adalah uji yang akan dimatikan.
 */
export function isValidSignature(input: SignatureInput, provided: string): boolean {
  const expected = Buffer.from(expectedSignature(input), 'utf8')
  const candidate = Buffer.from(provided, 'utf8')

  // timingSafeEqual MELEMPAR bila panjangnya berbeda, jadi panjang harus
  // diperiksa lebih dulu. Kebocoran informasinya nol: panjang tanda tangan
  // SHA-512 heksadesimal selalu 128 karakter dan itu pengetahuan umum.
  if (expected.length !== candidate.length) return false

  return timingSafeEqual(expected, candidate)
}
