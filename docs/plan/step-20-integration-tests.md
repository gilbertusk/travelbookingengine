# Step 20 — Uji integrasi dengan Testcontainers

**Fase 3** · Milestone 4 · Estimasi 6 jam · Prasyarat: Step 19

## Tujuan

Membuktikan saga bekerja terhadap infrastruktur sungguhan. NFR-19 melarang pengujian jalur kompensasi dengan tiruan, karena tiruan tidak punya balapan, tidak punya partisi, dan tidak punya kegagalan koneksi.

## Prompt

```
Bangun rangkaian uji integrasi yang menjalankan saga terhadap infrastruktur
sungguhan menggunakan Testcontainers.

Baca terlebih dahulu PRD NFR-19, M9, dan docs/plan/CONVENTIONS.md bagian 10.

1. Kerangka uji
   - Testcontainers menyalakan PostgreSQL, Redis, RabbitMQ, dan Kafka sungguhan
   - mock-supplier dijalankan sebagai kontainer juga, sehingga penyuntikan
     kegagalan tersedia di dalam uji
   - Kontainer dibagikan antar berkas uji dalam satu proses untuk kecepatan,
     tetapi keadaan dibersihkan antar uji
   - Migrasi Prisma dijalankan otomatis sebelum uji
   - Topik Kafka dibuat otomatis

2. Helper
   - Pembangun data uji yang membuat pemesanan pada keadaan tertentu
   - Helper untuk menunggu peristiwa muncul di Kafka dengan batas waktu
   - Helper untuk menunggu pemesanan mencapai keadaan tertentu
   - Helper untuk menyuntikkan kegagalan supplier di tengah uji
   - Seluruh penantian memakai polling dengan batas waktu, jangan memakai
     penundaan tetap. Penundaan tetap menghasilkan uji yang rapuh

3. Skenario yang wajib diuji (memenuhi M9 — 100% jalur kompensasi)
   - Alur bahagia lengkap dari price check sampai CONFIRMED
   - Supplier mati tepat setelah pembayaran: refund otomatis, mencapai REFUNDED
   - Supplier mengembalikan timeout pada konfirmasi, lalu pemesanan ternyata
     ada: diadopsi, mencapai CONFIRMED tanpa pemesanan ganda
   - Supplier mengembalikan timeout, pemesanan ternyata tidak ada: dicoba ulang
     dengan benar
   - Status tetap tidak dapat dipastikan: mencapai NEEDS_REVIEW
   - Pembayaran gagal setelah hold: hold terlepas di lokal dan di supplier
   - Hold kedaluwarsa tanpa pembayaran: mencapai EXPIRED, hold supplier terlepas
   - Refund gagal berulang: mencapai NEEDS_REVIEW dengan galat tingkat error
   - Proses booking-service dimatikan di tengah saga, lalu dihidupkan:
     saga dipulihkan dan mencapai keadaan final
   - Peristiwa Kafka dikirim ulang: tidak ada efek ganda
   - Dua permintaan pemesanan dengan idempotency key sama secara serentak:
     satu pemesanan

4. Verifikasi invarian
   Setelah setiap skenario, periksa invarian berikut selalu benar:
   - Tidak ada pemesanan di keadaan tidak final setelah saga selesai
   - Tidak ada pembayaran berhasil tanpa pemesanan terkonfirmasi atau refund
   - Tidak ada hold yatim di Redis maupun di supplier
   - Jumlah booking_events konsisten dengan keadaan akhir
   Buat helper assertInvariants yang dipanggil di akhir setiap uji

5. Integrasi dengan perkakas
   - Skrip pnpm test:integration
   - Terpisah dari uji unit supaya uji unit tetap cepat
   - Berjalan di CI, dengan batas waktu yang memadai

Commit: test: add saga integration tests with testcontainers
```

## Definisi Selesai

- [ ] Uji berjalan terhadap PostgreSQL, Redis, RabbitMQ, dan Kafka sungguhan
- [ ] mock-supplier berjalan sebagai kontainer dan kegagalannya dapat disuntikkan dari dalam uji
- [ ] Seluruh sebelas skenario pada daftar di atas ada dan lewat
- [ ] Helper `assertInvariants` dipanggil di akhir setiap skenario
- [ ] Tidak ada penundaan tetap di seluruh uji — hanya polling dengan batas waktu
- [ ] Uji dapat dijalankan berulang dengan hasil sama, tidak flaky
- [ ] Cakupan jalur kompensasi 100% tercapai
- [ ] `pnpm test:integration` berjalan di CI
- [ ] Commit terbuat

## Catatan

Skenario "proses dimatikan di tengah saga" adalah yang paling sulit ditulis dan paling banyak nilainya. Ia membuktikan pemulihan saga bekerja sungguhan. Kalau satu skenario saja harus dipilih untuk dibahas saat wawancara, pilih yang ini.
