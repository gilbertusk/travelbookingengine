# Step 24 — notification-service

**Fase 4** · Milestone 5 · Estimasi 4 jam · Prasyarat: Step 23

## Tujuan

Memberi tahu pengguna pada setiap perubahan penting, terutama saat terjadi kegagalan. Memenuhi FR-23 dan FR-28, dan menunjukkan pola consumer yang mengonsumsi dari kedua broker dengan peran berbeda.

## Prompt

```
Buat apps/notification-service.

Baca terlebih dahulu PRD FR-23, FR-28, NFR-05, dan docs/plan/CONVENTIONS.md.

Tulis test lebih dulu.

1. Dua jalur masuk, peran berbeda
   - Consumer Kafka untuk peristiwa: booking.confirmed, booking.failed,
     booking.cancelled, payment.refunded. Service ini memutuskan sendiri
     notifikasi apa yang perlu dikirim
   - Consumer RabbitMQ untuk perintah notification.send, ketika service lain
     secara eksplisit meminta pengiriman tertentu
   - Perbedaan ini adalah contoh konkret pemisahan peran dua broker.
     Catat di ADR

2. Template
   - Template surel untuk setiap jenis notifikasi
   - Bahasa Indonesia, nada tenang dan langsung
   - Versi HTML dan teks biasa. Banyak klien surel memblokir HTML
   - Surel kegagalan pemesanan WAJIB menjelaskan status pengembalian dana
     dengan jelas, termasuk perkiraan waktu. Ini kewajiban FR-23
   - Surel NEEDS_REVIEW menjelaskan bahwa pemesanan sedang diperiksa manual
     dan kapan pengguna akan dihubungi. Jangan berpura-pura berhasil
   - Voucher dilampirkan pada surel konfirmasi

3. Pengiriman
   - Port EmailSender dengan implementasi SMTP, diarahkan ke Mailpit
     untuk pengembangan
   - Deduplikasi: notifikasi yang sama untuk pemesanan yang sama tidak
     dikirim dua kali. Simpan catatan pengiriman
   - Pembatasan laju per penerima, untuk mencegah banjir notifikasi bila
     terjadi perulangan peristiwa

4. Ketahanan (NFR-05)
   - Kegagalan pengiriman TIDAK boleh menggagalkan alur pemesanan.
     Service ini adalah consumer, bukan bagian dari jalur kritis
   - Kegagalan mengikuti retry berjenjang lalu dead letter dengan peringatan
   - Kegagalan yang bersifat permanen, misalnya alamat tidak sah, tidak
     dicoba ulang

5. Catatan
   - Tabel notifications: id, bookingId, userId, type, channel, status,
     sentAt, dedupeKey unik
   - Payload yang dicatat tidak memuat data pribadi berlebihan

Test yang wajib:
- Peristiwa yang sama dua kali menghasilkan satu surel
- Surel kegagalan memuat informasi status pengembalian dana
- Kegagalan pengiriman tidak memengaruhi keadaan pemesanan
- Alamat tidak sah tidak memicu percobaan ulang
- Versi teks biasa tersedia untuk setiap template

Commit: feat: add notification service
```

## Definisi Selesai

`[x]` terbukti, `[~]` terbukti sebagian (sebabnya ditulis), `[ ]` belum.

- [x] Mengonsumsi dari Kafka dan RabbitMQ dengan peran yang jelas berbeda. Kafka adalah jalur keputusan (`domain/policy.ts`), RabbitMQ jalur permintaan (`notification.send`). Dicatat di [ADR-0003](../adr/0003-peran-dua-broker-di-notification-service.md). Keduanya diuji lewat pembungkus consumer `@tbe/messaging` yang sama dengan produksi, dan dijalankan sekali sebagai proses sungguhan terhadap Kafka, RabbitMQ, Postgres, dan Mailpit lokal. Pada jalan itu booking-service dan voucher-service masih tiruan HTTP.
- [x] Deduplikasi bekerja lewat batasan unik. `dedupe_key` UNIK dengan `INSERT ... ON CONFLICT DO NOTHING`. Lima permintaan serentak menghasilkan satu baris di Postgres sungguhan. Peristiwa yang sama dua kali menghasilkan satu surel di Mailpit.
- [x] Surel kegagalan menjelaskan status pengembalian dana. Kalimat pertama menyebut nilai dana dan bahwa dana dikembalikan otomatis, disusul perkiraan `3–14 hari kerja`. Pemesanan yang gagal sebelum ditagih dinyatakan "tidak ada dana yang ditagih".
- [x] Surel `NEEDS_REVIEW` jujur, tidak berpura-pura berhasil atau gagal. Surel menyebut "belum terkonfirmasi" dan janji kontak `1×24 jam` (sama dengan web), dibedakan antara pemeriksaan kamar dan pemeriksaan pengembalian dana. Surel kegagalan untuk pemesanan yang sudah NEEDS_REVIEW ditolak disusun.
- [x] Setiap template punya versi teks biasa. Satu model pesan dirender menjadi dua keluaran; diuji untuk setiap template.
- [x] Kegagalan pengiriman tidak memengaruhi alur pemesanan. Consumer hanya mencatat satu baris. Satu-satunya port ke booking-service adalah port baca. SMTP yang mati tidak menahan partisi maupun antrian.
- [x] Voucher terlampir pada surel konfirmasi. Lampiran `e-voucher.pdf` terbukti tiba di Mailpit (uji integrasi). Surel konfirmasi menunggu voucher alih-alih terkirim tanpa voucher.
- [x] Surel terlihat benar di Mailpit. Keenam contoh dikirim lewat `preview:mail`. Tiga di antaranya (konfirmasi, kegagalan, pemeriksaan manual) diperiksa sebagai tangkapan layar. Pemeriksa HTML Mailpit memberi skor dukungan 88,8% untuk surel kegagalan.
- [x] Cakupan test ≥ 80%. notification-service 97,8% pernyataan (ambang 85%). voucher-service 97,6%, booking-service 99,9%.
- [x] Commit terbuat

## Temuan

### Bahan surel tidak dibawa peristiwa

Peristiwa Kafka sengaja tidak membawa alamat surel, dan sebagian besar tidak membawa userId. Dua rute `/internal` baru melengkapinya:

- `GET /internal/bookings/:id/notification-source` (booking-service). Rute ini membawa surel tamu utama, dan hanya bidang yang disebut surel.
- `GET /internal/vouchers/:bookingId/document` (voucher-service). Rute ini mengembalikan isi PDF; kunci objek tetap tidak keluar.

Alamat surel dan nama tamu tidak pernah disimpan notification-service.

### Percobaan ulang hidup di Postgres, bukan di RabbitMQ

Jalur Kafka tidak punya jenjang tunda, jadi percobaan ulang **pengiriman** untuk kedua sumber ada di tabel `notifications`: jenjang 5 dtk, 30 dtk, 2 mnt, 10 mnt, 30 mnt, lalu `DEAD`. Pengambilan memakai sewa dan `FOR UPDATE SKIP LOCKED`. Jenjang RabbitMQ hanya menampung kegagalan **mencatat** perintah.

### Temuan code review yang diperbaiki

- **Sewa per batch** membuat baris di ujung batch kehabisan sewa sebelum gilirannya, lalu dikirim dua kali oleh instance lain. Sekarang penghantar mengambil satu baris per kali. Hasil hanya dicatat bila sewanya masih dipegang. Sewa yang habis dihitung sebagai percobaan, sehingga berakhir `DEAD lease_exhausted`.
- **Baris beracun.** `context` yang tidak dapat diurai dulu dilempar sesudah baris tersewa, dan itu menghentikan seluruh penghantaran. Sekarang baris itu menjadi `DEAD invalid_context`.
- **Voucher yang terlambat** lebih dari seluruh jenjang membuat surel konfirmasi `DEAD`, lalu `voucher.issued` ditolak sebagai duplikat. Sekarang `voucher.issued` menghidupkannya lagi. Duplikat hanya membangunkan baris yang menunggu voucher, tidak melompati jenjang kegagalan lain.
- **Klasifikasi SMTP terlalu keras.** Setiap 5xx dulu dianggap salah penerima, sehingga IP di daftar hitam (5.7.x) atau pengirim yang ditolak membuang seluruh surel tanpa dicoba ulang. Sekarang hanya 550–553 saat `RCPT TO` yang permanen.
- **Surel kegagalan untuk NEEDS_REVIEW** menjanjikan pengembalian "otomatis" yang sedang tertahan. Sekarang surel itu ditolak; surel pemeriksaan manual yang berbicara.
- **Kunci penerima** dulu SHA-256 polos, yang dapat dicocokkan ke daftar alamat. Sekarang HMAC dengan `RECIPIENT_KEY_SECRET`.
- **Alamat berkoma** (`a@x.com,b@y.com`) dibaca pustaka SMTP sebagai dua penerima. Sekarang ditolak sebagai alamat tidak sah.

### Utang

Lihat README service. Ringkasnya:

- Peristiwa selama service mati lebih dari 48 jam tidak dikirimi surel.
- Proses yang mati sesudah SMTP menerima surel tetapi sebelum barisnya ditandai SENT akan mengirimnya sekali lagi.
- Aturan peringatan Prometheus dan Alertmanager belum ada.
- notification-service dan voucher-service belum masuk rangkaian uji saga (tests/saga).

## Catatan

Surel kegagalan adalah surel terpenting di seluruh sistem. Pengguna yang baru saja kehilangan kamar sedang cemas soal uangnya. Kalimat pertama harus menjawab kecemasan itu, bukan meminta maaf panjang lebar.
