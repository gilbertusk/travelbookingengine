# notification-service

Memberi tahu pengguna lewat surel setiap kali pemesanannya berubah penting, terutama saat gagal. Memenuhi FR-23, FR-28, dan NFR-05.

Port 4009. Contoh consumer yang membaca dari **kedua** broker dengan peran berbeda — lihat [ADR-0003](../../docs/adr/0003-peran-dua-broker-di-notification-service.md).

## Alur

```
Kafka (peristiwa)                          RabbitMQ (perintah)
booking.confirmed  booking.failed          notification.send
booking.cancelled  payment.refunded              │
voucher.issued                                   │
      │                                          │
      ▼  domain/policy.ts MEMUTUSKAN             ▼  pengirim SUDAH memutuskan
      └──────────────┐                ┌──────────┘
                     ▼                ▼
          Postgres: notifications (UNIK dedupe_key)
                     │
                     ▼  penghantar (application/deliver.ts)
   booking-service  GET /internal/bookings/:id/notification-source   alamat, nama, status
   voucher-service  GET /internal/vouchers/:bookingId/document       PDF, khusus konfirmasi
                     │
                     ▼
                SMTP → Mailpit (http://localhost:8025)
```

Consumer hanya **mencatat**, satu tulisan ke basis data, lalu membangunkan penghantar. Pengiriman, percobaan ulang, dan dead letter seluruhnya ada di penghantar. Server SMTP yang mati tidak pernah menahan partisi Kafka maupun antrian RabbitMQ, dan tidak pernah menyentuh pemesanan. Satu-satunya jalan service ini ke booking-service adalah port baca.

## Peristiwa mana menjadi surel apa

| Peristiwa                                                                   | Surel                                            |
| --------------------------------------------------------------------------- | ------------------------------------------------ |
| `booking.confirmed`, `voucher.issued`                                       | konfirmasi + e-voucher terlampir (satu surel)    |
| `booking.failed`                                                            | kegagalan: nasib uang di kalimat pertama         |
| `booking.failed` + `requiresManualReview`                                   | sedang diperiksa (kamar, atau pengembalian dana) |
| `booking.cancelled` (`user_request`, `payment_failed`, `supplier_rejected`) | pembatalan                                       |
| `booking.cancelled` (`hold_expired`)                                        | tidak ada: belum ada yang dibayar                |
| `payment.refunded`                                                          | pengembalian dana sudah dikirim                  |

Surel konfirmasi punya dua pemicu karena wajib membawa voucher, dan voucher terbit sesudah konfirmasi. `booking.confirmed` mencatat surelnya, lalu penghantar menunggu vouchernya (`voucher_not_ready` adalah kegagalan sementara). `voucher.issued` memakai kunci yang sama dan memajukan jadwalnya ke sekarang. Bila vouchernya terlambat lebih dari seluruh jenjang tunda dan surelnya sudah `DEAD`, `voucher.issued` menghidupkannya lagi. Duplikat hanya membangunkan baris yang menunggu voucher; ia tidak pernah melompati jenjang tunda kegagalan lain, misalnya SMTP yang mati.

## Deduplikasi

Batasan UNIK `dedupe_key`, lewat `INSERT ... ON CONFLICT DO NOTHING`. Tidak ada pemeriksaan "sudah ada?" yang dapat berpacu.

- Peristiwa: `<jenis>:<bookingId>`, refund `refund_completed:<bookingId>:<refundId>`. Peristiwa yang dibaca dua kali dan `voucher.issued` yang diterbitkan ulang untuk setiap perintah ganda berakhir di satu baris.
- Perintah: `command:<eventId perintah>`. Perintah yang diantar ulang RabbitMQ berakhir di satu baris. Dua perintah berbeda tetap dua surel, karena perintah adalah permintaan eksplisit, misalnya kirim ulang dari operator.

## Kegagalan

| Keadaan                                                                                 | Hasil                                                                              |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Alamat tidak sah (tidak lolos pemeriksaan, belum pernah dikirim)                        | `FAILED invalid_address`, tidak dicoba ulang                                       |
| Server SMTP menolak **penerima** saat `RCPT TO` (550/551/552/553, bukan 5.7.x)          | `FAILED smtp_55x`, tidak dicoba ulang                                              |
| SMTP 4xx, jaringan, booking-service/voucher-service tersendat, voucher belum terbit     | tunda 5 dtk → 30 dtk → 2 mnt → 10 mnt → 30 mnt, lalu `DEAD`                        |
| SMTP 5xx lain: autentikasi, kebijakan 5.7.x (IP di daftar hitam), pengirim ditolak, 554 | dianggap sementara (salah konfigurasi kita), berakhir `DEAD` beserta peringatannya |
| Pemesanan tidak ada, atau keadaannya tidak lagi cocok dengan surel                      | `SKIPPED`                                                                          |
| Melewati 10 surel per penerima per jam                                                  | ditunda 15 menit, **tidak** dibuang                                                |

`DEAD` dan `FAILED` dicatat di log tingkat `error` dan di metrik `notification_deliveries_total{outcome="dead"|"failed"}`. Aturan peringatannya: `increase(notification_deliveries_total{outcome="dead"}[15m]) > 0`.

Setiap surel menolak disusun bila keadaan pemesanan sudah tidak cocok dengan isinya. Contohnya surel "sedang diperiksa" untuk pemesanan yang ternyata sudah CONFIRMED, atau surel konfirmasi tanpa kode supplier.

## Sewa dan penghantar ganda

Penghantar mengambil **satu** baris per kali dengan `FOR UPDATE SKIP LOCKED`, lalu menyewanya selama `DELIVERY_LEASE_MS`. Sewa per baris, bukan per batch: sewa batch berjalan untuk seluruh baris sekaligus, padahal barisnya dikirim berurutan, sehingga baris di ujung batch bisa kehabisan sewa dan diambil instance lain.

- Hasil dicatat hanya bila sewanya masih dipegang (`status = SENDING` dan `lease_until` sama). Penghantar yang terlambat tidak menimpa hasil penggantinya.
- Sewa yang habis (penghantarnya mati) diambil lagi dan dihitung sebagai satu percobaan. Baris yang selalu mematikan penghantar berhenti di `DEAD lease_exhausted`.
- Baris yang `context`-nya tidak dapat diurai, misalnya ditulis versi lain, menjadi `DEAD invalid_context`. Baris itu tidak menghentikan penghantaran baris lain.

## Data pribadi

- Alamat surel dan nama tamu **tidak** disimpan. Keduanya dibaca dari booking-service tepat sebelum surel disusun.
- `recipient_key` adalah HMAC-SHA-256 alamat yang dinormalkan, dengan rahasia `RECIPIENT_KEY_SECRET`. Hanya untuk pembatasan laju, dan tidak dapat dicocokkan ke daftar alamat tanpa rahasianya.
- `context` hanya memuat alasan dan nilai uang yang disebut surel.
- `last_error` hanya kode (`smtp_550`, `upstream_error`), tidak pernah teks balasan server, karena balasan SMTP sering menyebut alamat penerima.

## Template

`src/domain/templates/`. Satu model pesan dirender menjadi dua keluaran, teks biasa dan HTML, sehingga isi keduanya tidak dapat berbeda. Nada mengikuti halaman status pemesanan di apps/web: memakai "kamu", tenang, dan surel yang menyangkut uang membuka dengan nasib uangnya. Perkiraan sampainya pengembalian dana adalah `3–14 hari kerja`. Janji kontak pemeriksaan manual adalah `1×24 jam`, sama dengan web.

Melihat semua template di Mailpit:

```bash
pnpm --filter @tbe/notification-service build
pnpm --filter @tbe/notification-service preview:mail   # lalu buka http://localhost:8025
```

Pemeriksa HTML Mailpit memberi skor dukungan klien 88,8% untuk surel kegagalan. Yang tidak didukung penuh hanya gaya presentasi (padding, border-radius, letter-spacing) di klien lama.

## Batas umur peristiwa

Consumer membaca dari awal topik untuk partisi yang belum punya offset. Peristiwa yang lebih tua dari `MAX_EVENT_AGE_HOURS` (48 jam) dilewati. Tanpa batas ini, penerapan pertama akan mengirim surel untuk setiap pemesanan 90 hari terakhir.

## Pengujian

```bash
pnpm --filter @tbe/notification-service test               # unit, cakupan ≥ 85%
pnpm --filter @tbe/notification-service test:integration   # Postgres + Mailpit sungguhan
```

Uji integrasi membuktikan batasan UNIK, `FOR UPDATE SKIP LOCKED` pada dua penghantar yang berpacu, sewa yang habis diambil lagi, dan surel yang benar-benar tiba di Mailpit dengan versi teks, HTML, dan lampiran. Uji ini juga memakai fitur chaos Mailpit untuk penolakan 550 (permanen) dan 451 (sementara).

## Utang

- **Peristiwa selama service mati lebih dari 48 jam tidak dikirimi surel.** Harga dari batas umur di atas.
- **Kirim lalu mati.** Proses yang mati di antara SMTP menerima surel dan baris ditandai SENT akan mengirimnya sekali lagi setelah sewanya habis. SMTP tidak punya kunci idempoten.
- **Perintah tanpa `bookingId`** langsung ke dead letter. Belum ada template yang tidak menyangkut pemesanan.
- **Rute `/internal`** hanya dilindungi oleh fakta bahwa gateway tidak merutekannya. Utang yang sama dengan Step 23.
- **Aturan peringatan belum dipasang.** Metrik dan ekspresinya ada, tetapi infra belum punya Alertmanager maupun berkas aturan Prometheus. `DEAD` saat ini hanya terlihat di log `error` dan di Grafana.
- **Belum masuk rangkaian uji saga** (tests/saga). Alur pemesanan → surel belum pernah dijalankan ujung ke ujung dengan seluruh service.
