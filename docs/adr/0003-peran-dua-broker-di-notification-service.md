# ADR-0003 — Peran dua broker di notification-service

**Status:** Diterima · **Tanggal:** 2026-10-08 · **Menjawab:** Step 24, butir 1

## Konteks

Sejak Step 05, `@tbe/messaging` memisahkan dua broker lewat bentuk API-nya. **Kafka membawa peristiwa**: fakta yang sudah terjadi, boleh dibaca banyak pihak yang tidak saling tahu, dan boleh diabaikan. **RabbitMQ membawa perintah**: pekerjaan yang ditujukan kepada satu pihak, wajib dikerjakan, dan dicoba ulang bila gagal.

Sampai Step 23, setiap service hanya memakai salah satu peran untuk satu jenis pesan. Pemisahan itu benar tetapi belum pernah diuji pada satu service yang menerima keduanya untuk pekerjaan yang tampak sama, yaitu "kirim surel". notification-service adalah service pertama yang seperti itu, dan ada godaan nyata untuk menyatukan keduanya:

- semua lewat Kafka, sehingga service lain yang ingin surel cukup menerbitkan "peristiwa" `notification.requested`; atau
- semua lewat RabbitMQ, sehingga booking-service mengirim perintah `notification.send` di setiap transisi.

## Keputusan

notification-service membaca dari kedua broker, dengan peran yang berbeda dan tidak saling menggantikan.

### Kafka: service ini yang memutuskan

Consumer group `notification-service` membaca `booking.confirmed`, `booking.failed`, `booking.cancelled`, `payment.refunded`, dan `voucher.issued`. Tidak satu pun penerbitnya tahu notification-service ada. Mereka hanya mengumumkan fakta.

Keputusan surel mana yang dikirim tinggal di `domain/policy.ts`. Beberapa contohnya:

- `booking.failed` yang menuntut pemeriksaan manual **bukan** surel kegagalan.
- `hold_expired` tidak menghasilkan surel apa pun.
- `booking.confirmed` dan `voucher.issued` menjadi **satu** surel.

Keputusan ini milik notification-service, bukan milik booking-service.

### RabbitMQ: pengirim sudah memutuskan

Antrian `tbe.notification.send` menerima perintah dari pihak yang secara eksplisit meminta surel tertentu, misalnya operator yang mengirim ulang konfirmasi atau rekonsiliasi (Step 28). Tidak ada kebijakan yang dijalankan. Template yang diminta adalah template yang dikirim, selama keadaan pemesanan masih cocok dengan isinya.

### Keduanya bertemu di satu tabel

Kedua consumer hanya mencatat baris di `notifications`. Penghantar yang sama mengirim surel dari kedua sumber. Yang berbeda hanya kunci deduplikasinya:

| Sumber   | Kunci                 | Artinya                                               |
| -------- | --------------------- | ----------------------------------------------------- |
| Kafka    | `<jenis>:<bookingId>` | satu surel jenis ini per pemesanan, apa pun pemicunya |
| RabbitMQ | `command:<eventId>`   | satu surel per perintah; perintah kedua = surel kedua |

## Pilihan yang dipertimbangkan

**Semua lewat Kafka (`notification.requested`).** Ditolak. "Peristiwa" yang isinya permintaan adalah perintah yang menyamar. Kafka tidak punya jalan menolak satu pesan tanpa menahan partisinya, tidak punya antrian tunda, dan tidak punya dead letter per pesan. Penerbit juga tidak dapat tahu bahwa permintaannya ditolak.

**Semua lewat RabbitMQ (booking-service mengirim perintah di setiap transisi).** Ditolak. Keputusan "surel apa untuk transisi apa" pindah ke booking-service, padahal booking-service seharusnya tidak tahu notification-service ada. Perubahan nada surel atau penambahan surel baru akan menuntut perubahan di saga pemesanan. Booking-service juga harus mengirim perintah di dalam transaksi transisinya, atau menambah satu lagi pesan outbox. Itu kerumitan di jalur kritis demi sesuatu yang bukan jalur kritis (NFR-05).

**Percobaan ulang pengiriman lewat jenjang RabbitMQ.** Ditolak untuk kegagalan **kirim**. Jalur Kafka tidak punya jenjang tunda, dan menyalin peristiwa ke RabbitMQ hanya untuk mendapat jenjang akan mencampur kedua peran lagi. Percobaan ulang pengiriman hidup di tabel `notifications` (`next_attempt_at`, sewa baris, `FOR UPDATE SKIP LOCKED`), sama untuk kedua sumber. Jenjang RabbitMQ tetap dipakai untuk kegagalan **mencatat** perintah, misalnya basis data yang mati, karena itulah kegunaannya.

## Konsekuensi

- Penerbit peristiwa tidak berubah sama sekali untuk Step 24. booking-service hanya mendapat satu rute baca `/internal/bookings/:id/notification-source`, karena peristiwa sengaja tidak membawa alamat surel.
- Ada dua jenis "dead letter" yang berbeda:
  - perintah cacat atau tanpa pemesanan masuk dead letter **RabbitMQ**;
  - surel yang percobaannya habis menjadi baris `DEAD` di **Postgres**, dengan log `error` dan metrik `notification_deliveries_total{outcome="dead"}`.

  Keduanya didokumentasikan di README service.

- Kebijakan surel dapat diuji tanpa broker. `domain/policy.ts` menerima fakta milik domain, bukan amplop pesan.
- Kirim ulang yang disengaja hanya mungkin lewat perintah. Peristiwa yang diputar ulang (misalnya `voucher.issued` yang diterbitkan lagi) tidak pernah menghasilkan surel kedua.

## Catatan

Uji yang menjaga keputusan ini ada di `src/messaging/booking-events.test.ts` dan `src/messaging/send-command.test.ts`. Keduanya berjalan lewat pembungkus consumer `@tbe/messaging` yang sama dengan produksi.
