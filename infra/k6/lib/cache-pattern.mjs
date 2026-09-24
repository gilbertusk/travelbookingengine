/**
 * Berapa banyak kriteria berbeda yang beredar di skenario cache.
 *
 * Dipisahkan ke berkas sendiri supaya skenario k6 dan skrip verifikasi
 * membaca angka yang SAMA. Angka yang disalin ke dua tempat akan berbeda di
 * salah satunya, dan yang diverifikasi menjadi pola yang bukan pola yang
 * dijalankan.
 *
 * 40 dipilih, bukan dikarang: skenario cache berjalan tiga menit dengan
 * puncak 40 VU yang masing-masing menunggu satu detik antar permintaan —
 * kira-kira 5.000 permintaan. Empat puluh di antaranya meleset karena
 * memang belum ada di cache, dan TTL lapis pertama lima menit berarti tidak
 * ada yang kedaluwarsa selama uji berlangsung.
 *
 * Batas bawah rasio cache hit yang menyusul: 1 − 40/5.000 ≈ 99%. Ambang M3
 * di 70% karena itu punya ruang besar — dan ruang itu disengaja. Ambang yang
 * pas-pasan akan gagal karena satu VU yang kebetulan lambat memulai, bukan
 * karena cache-nya berhenti bekerja.
 */
export const DISTINCT_CRITERIA = 40
