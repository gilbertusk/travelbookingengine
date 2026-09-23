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

- [ ] Mengonsumsi dari Kafka dan RabbitMQ dengan peran yang jelas berbeda
- [ ] Deduplikasi bekerja lewat batasan unik
- [ ] Surel kegagalan menjelaskan status pengembalian dana
- [ ] Surel `NEEDS_REVIEW` jujur, tidak berpura-pura berhasil atau gagal
- [ ] Setiap template punya versi teks biasa
- [ ] Kegagalan pengiriman tidak memengaruhi alur pemesanan
- [ ] Voucher terlampir pada surel konfirmasi
- [ ] Surel terlihat benar di Mailpit
- [ ] Cakupan test ≥ 80%
- [ ] Commit terbuat

## Catatan

Surel kegagalan adalah surel terpenting di seluruh sistem. Pengguna yang baru saja kehilangan kamar sedang cemas soal uangnya. Kalimat pertama harus menjawab kecemasan itu, bukan meminta maaf panjang lebar.
