# Step 23 — voucher-service

**Fase 4** · Milestone 5 · Estimasi 4 jam · Prasyarat: Step 22

## Tujuan

Menerbitkan bukti pemesanan yang sah. Memenuhi FR-24 dan M7, sekaligus menjadi contoh consumer RabbitMQ untuk pekerjaan berat yang tidak boleh membuat pengguna menunggu.

## Prompt

```
Buat apps/voucher-service.

Baca terlebih dahulu PRD FR-24, M7, dan docs/plan/CONVENTIONS.md.

Tulis test lebih dulu.

1. Consumer
   - Mengonsumsi perintah voucher.generate dari RabbitMQ
   - Idempoten: perintah yang sama tidak menghasilkan voucher ganda.
     Bila voucher untuk bookingId sudah ada, kembalikan yang lama
   - Kegagalan mengikuti retry berjenjang, lalu dead letter

2. Pembuatan PDF
   - Memakai PDFKit
   - Isi wajib: booking reference dari supplier, nama properti dan alamat,
     tanggal masuk dan keluar, jenis kamar, nama tamu, jumlah tamu,
     rincian harga, kebijakan pembatalan, dan kontak properti
   - Kode QR berisi booking reference
   - Tata letak mengikuti arah visual DESIGN-SYSTEM.md: tenang, tipografi jelas,
     tanpa hiasan berlebihan. Voucher yang dicetak harus tetap terbaca
     dalam hitam putih
   - Ukuran A4, dan pastikan teks tidak terpotong untuk nama properti panjang

3. Penyimpanan
   - Unggah ke MinIO di bucket vouchers
   - Kunci objek tidak boleh dapat ditebak. Jangan memakai bookingId mentah
   - Simpan metadata di database: bookingId, objectKey, issuedAt, sizeBytes

4. Akses
   - GET /vouchers/:bookingId menghasilkan URL bertanda tangan berumur pendek
   - Hanya pemilik pemesanan yang boleh mengakses. Periksa kepemilikan,
     jangan hanya mengandalkan ketidaktahuan URL
   - Pemesanan yang belum CONFIRMED tidak punya voucher, dan endpoint
     mengembalikan galat yang jelas

5. Peristiwa
   - Setelah voucher terbit, terbitkan peristiwa agar notification-service
     dapat mengirimkannya
   - Ukur selisih waktu dari booking.confirmed sampai voucher terbit
     sebagai metrik, untuk membuktikan M7

Test yang wajib:
- Perintah yang sama dua kali menghasilkan satu voucher
- PDF berisi seluruh field wajib — periksa dengan mengekstrak teks dari PDF
- Nama properti yang sangat panjang tidak membuat teks terpotong
- Pengguna lain tidak dapat mengakses voucher milik orang lain
- Pemesanan belum CONFIRMED menghasilkan galat yang jelas

Commit: feat: add voucher service
```

## Definisi Selesai

`[x]` terbukti, `[~]` terbukti sebagian (sebabnya ditulis), `[ ]` belum.

- [x] Consumer idempoten, perintah ganda tidak menghasilkan voucher ganda — lewat pembungkus consumer sungguhan (unit), dan dua penerbitan SERENTAK terhadap Postgres + MinIO sungguhan menghasilkan satu baris dan satu berkas pemenang (integrasi)
- [x] PDF memuat seluruh field wajib, diverifikasi dengan ekstraksi teks (`unpdf`), juga untuk nama properti 200+ karakter dan rincian harga 30 baris
- [x] Voucher terbaca dalam cetakan hitam putih — uji memeriksa setiap operator warna di aliran isi PDF bernilai abu-abu (r = g = b)
- [x] Kunci objek tidak dapat ditebak — token CSPRNG 256-bit, `v/<token>.pdf`; uji memastikan bookingId tidak muncul di kunci
- [x] Kepemilikan diperiksa, bukan hanya mengandalkan URL rahasia — voucher orang lain dijawab 404 tanpa menandatangani URL apa pun
- [x] URL bertanda tangan berumur pendek — 5 menit, `cache-control: no-store`; uji integrasi membuktikan URL dapat diunduh, URL yang diubah ditolak MinIO (403), dan objek tanpa tanda tangan tidak dapat dibuka
- [~] M7 tercapai: p95 di bawah 30 detik dari konfirmasi sampai voucher terbit — histogram `voucher_issue_latency_seconds` dan `voucher.issued.latencyMs` ada dan teruji, tetapi BELUM diukur ujung ke ujung: voucher-service belum masuk rangkaian uji saga/beban (tests/saga), jadi belum ada angka p95 dari jalan sungguhan
- [x] Cakupan test ≥ 80% — voucher-service 97,5% (ambang 85%); booking-service 99,9%
- [x] Commit terbuat

## Temuan

### Bahan voucher tidak ada di mana pun

Prompt menganggap seluruh field voucher sudah tersedia. Ternyata tidak: pemesanan hanya menyimpan `propertyId` (pengenal SUPPLIER) dan `ratePlanRef`. Jenis kamar, nama rate plan, dan kebijakan pembatalan tidak tercatat, dan katalog tidak punya kontak properti. Keputusan (dipilih pengguna):

- booking-service menyalin **ketentuan tawaran** saat price check ke kolom `offer_terms`. Asalnya hasil pencarian yang dikirim peramban, sama seperti `city`.
- Katalog search-service mendapat kolom `phone` dan `email` (nullable). mock-supplier menerbitkan kontak karangan, dan seed menyalinnya.
- Dua rute `/internal` baru: `GET /internal/bookings/:id/voucher-source` (booking-service) dan `GET /internal/catalog/properties/by-supplier/:supplier/:id` (search-service). Keduanya tidak dirutekan api-gateway.

### Temuan code review yang diperbaiki

- 404 telanjang (URL dasar salah, rute belum dikerahkan) dulu dibaca sebagai "pemesanan tidak ada", sehingga perintah untuk pemesanan yang sudah dibayar langsung masuk dead letter. Sekarang hanya 404 beramplop `NOT_FOUND` yang berarti "tidak ada"; sisanya dicoba lagi.
- Properti yang belum terpetakan dulu langsung masuk dead letter. Padahal keadaan itu sementara: operator memetakannya, dan snapshot katalog yang baru dimuat ulang juga menjawab 404. Sekarang dicoba lagi berjenjang (503).

### Utang

- **Ketentuan tawaran tidak diverifikasi.** Harga diverifikasi ke supplier, ketentuannya tidak. Pengguna yang memanggil API langsung dapat menulis "pembatalan gratis 365 hari" di vouchernya sendiri. Perbaikan yang benar: supplier mengembalikan ketentuan saat price check, atau booking-service mencocokkannya ke rate plan di sisi server.
- Berkas PDF yatim di MinIO bila proses mati di antara unggah dan simpan metadata. Setiap percobaan memakai token baru. Belum ada aturan lifecycle atau penyapu.
- Rute `/internal` hanya dilindungi oleh fakta bahwa gateway tidak merutekannya. Belum ada kebijakan jaringan atau rahasia bersama.
- M7 belum diukur ujung ke ujung (lihat di atas).

## Catatan

Memeriksa kepemilikan meskipun URL sudah bertanda tangan adalah lapisan kedua yang sering dilewati. URL bisa bocor lewat riwayat peramban, log proksi, atau dibagikan tanpa sengaja.
