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

- [x] Uji berjalan terhadap PostgreSQL, Redis, RabbitMQ, dan Kafka sungguhan — Testcontainers di `packages/testing-infra`, dipakai `tests/saga` dan uji integrasi booking-service. Kontainer dinyalakan sekali per jalannya Vitest; migrasi Prisma (`migrate deploy`, bukan `db push`), seed, dan topik Kafka dibuat otomatis. Empat service (booking, payment, supplier, pricing) berjalan sebagai proses OS `node dist/index.js`
- [x] mock-supplier berjalan sebagai kontainer dan kegagalannya dapat disuntikkan dari dalam uji — dibangun dari `apps/mock-supplier/Dockerfile`. Kegagalan terjadwal per operasi (`/admin/:supplier/faults`) dan kontainer yang benar-benar dihentikan untuk "supplier mati"
- [x] Seluruh sebelas skenario pada daftar di atas ada dan lewat — ditambah dua: pembayaran terlambat yang diterbitkan ulang, dan konfirmasi supplier yang terlambat (kompensasi `cancelSupplierBooking`). Lihat peta skenario di Bukti
- [x] Helper `assertInvariants` dipanggil di akhir setiap skenario — keempat invarian, ditambah outbox yang terkuras dan tidak ada pemesanan ganda di supplier
- [x] Tidak ada penundaan tetap di seluruh uji — hanya polling dengan batas waktu. Termasuk empat penundaan tetap di uji integrasi Step 17 dan 19 yang diganti di step ini. Pembuktian "tidak terjadi apa-apa" memakai offset consumer group Kafka yang sudah ter-commit dan isi outbox, bukan jeda satu detik
- [~] Uji dapat dijalankan berulang dengan hasil sama, tidak flaky — **sebagian.** Putaran akhir hijau. Sebelumnya, setiap kegagalan ditelusuri sampai penyebabnya dan diperbaiki (lihat Temuan). Satu yang belum terjelaskan: proses node keluar dengan 0xC0000409 dan stderr kosong, dua kali dalam tiga putaran penuh, di Windows. Diagnostiknya sudah dipasang, tetapi penyebabnya belum tertangkap
- [x] Cakupan jalur kompensasi 100% tercapai — keempat aksi kompensasi di `SAGA_DEFINITION` dijalankan terhadap infrastruktur sungguhan. Lihat peta kompensasi di Bukti
- [~] `pnpm test:integration` berjalan di CI — **workflow ada** (`.github/workflows/integration.yml`, batas 45 menit), **belum pernah berjalan**: branch ini belum di-push
- [x] Commit terbuat — `test: add saga integration tests with testcontainers`

## Catatan

Skenario "proses dimatikan di tengah saga" adalah yang paling sulit ditulis dan paling banyak nilainya. Ia membuktikan pemulihan saga bekerja sungguhan. Kalau satu skenario saja harus dipilih untuk dibahas saat wawancara, pilih yang ini.

## Bukti

### Infrastruktur

Docker Desktop di Windows 11, Node 24.15. Testcontainers 12.1 menyalakan PostgreSQL, Redis, Kafka, RabbitMQ, dan mock-supplier. Tidak ada env `INTEGRATION_*`; kontainer infra pengembangan tidak dipakai.

### Peta skenario

| #   | Skenario wajib                                                       | Uji                                                                                        |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | Alur bahagia sampai CONFIRMED                                        | `happy-path` › alur bahagia                                                                |
| 2   | Supplier mati tepat setelah pembayaran → REFUNDED                    | `supplier-down` › konfirmasi gagal pasti → refund otomatis                                 |
| 3   | Timeout konfirmasi, pemesanan ternyata ada → diadopsi                | `supplier-uncertainty` › pemesanan ternyata ada                                            |
| 4   | Timeout konfirmasi, pemesanan ternyata tidak ada → dicoba ulang      | `supplier-uncertainty` › pemesanan ternyata tidak ada                                      |
| 5   | Status tidak dapat dipastikan → NEEDS_REVIEW                         | `supplier-uncertainty` › status tetap tidak dapat dipastikan                               |
| 6   | Pembayaran gagal setelah hold → hold lepas lokal dan di supplier     | `hold-lifecycle` › pembayaran gagal setelah hold                                           |
| 7   | Hold kedaluwarsa → EXPIRED, hold supplier lepas                      | `hold-lifecycle` › hold kedaluwarsa tanpa pembayaran                                       |
| 8   | Refund gagal berulang → NEEDS_REVIEW dengan galat tingkat error      | `supplier-down` › refund gagal berulang                                                    |
| 9   | booking-service dimatikan di tengah saga lalu dihidupkan             | `crash-recovery` › dua titik: saat menunggu hold supplier, saat menunggu pembayaran        |
| 10  | Peristiwa Kafka dikirim ulang → tidak ada efek ganda                 | `happy-path` › payment.succeeded diterbitkan ulang; pembayaran terlambat diterbitkan ulang |
| 11  | Dua permintaan dengan idempotency key sama serentak → satu pemesanan | `happy-path` › dua price check serentak                                                    |

Skenario 9 memakai SIGKILL pada proses OS sungguhan. Tidak ada kode penutupan yang sempat berjalan, dan offset Kafka yang belum di-commit tetap belum di-commit. Di Step 19 ini baru disimulasikan dengan galat yang tidak ditangkap.

### Peta kompensasi (M9)

| Langkah                      | Kompensasi                       | Dijalankan oleh                                                                                |
| ---------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------- |
| `holdLocal`                  | `releaseLocalHold` (langsung)    | pembayaran gagal; hold kedaluwarsa; proses mati saat `holdSupplier`; supplier mati → refund    |
| `holdSupplier`               | `lapses`                         | hold di mock-supplier benar-benar hilang sendiri (invarian "tidak ada hold yatim di supplier") |
| `awaitPayment`               | `refundPayment` (outbox)         | supplier mati → REFUNDED; refund gagal → NEEDS_REVIEW; pembayaran setelah EXPIRED → refund     |
| `confirmSupplier`            | `cancelSupplierBooking` (outbox) | konfirmasi yang tiba setelah REFUNDED → pemesanan di mock-supplier menjadi CANCELLED           |
| `priceCheck`, `issueVoucher` | `nothing` / maju                 | tidak ada yang dikompensasi                                                                    |

`cancelSupplierBooking` baru dijalankan rangkaian ini pada sesi terakhir step ini. Tanpa skenario itu, M9 belum terpenuhi.

### Uji

- `tests/saga`: **14 uji** dalam 5 berkas. Satu putaran penuh sekitar 17 menit; sebagian besar waktunya menunggu jenjang retry RabbitMQ yang sungguhan (5 s, 30 s, 2 m).
- booking-service: **56 uji integrasi**, kini di atas Testcontainers.
- Seluruh perintah verifikasi hijau: `install`, `build`, `lint`, `typecheck`, `format:check`, `test`, `verify:*`, `test:integration`.

## Temuan

Uji integrasi lintas service adalah pertama kalinya `index.ts` setiap service, skrip seed, dan consumer Kafka dijalankan sungguhan. Sebagian besar temuan di bawah adalah cacat produksi, bukan cacat uji.

### Cacat produksi

- **supplier-service mati saat startup** dengan ReferenceError. Registry metrik dibaca lewat fungsi "tertunda" yang ternyata dipanggil sebelum nilainya ada. Tidak ada yang tahu, karena `index.ts` tidak pernah dijalankan. Registry kini dibuat lebih dulu dan diberikan ke keduanya.
- **Skrip seed tidak pernah bisa berjalan.** `--experimental-strip-types` tidak memetakan `.js` ke `.ts`, jadi impor ke `src/` gagal. Seed kini mengimpor dari `dist/`, sehingga `pnpm build` wajib lebih dulu. Di search-service, campuran `src/` dan `dist/` juga menghasilkan dua tipe PrismaClient yang bentrok saat typecheck.
- **Consumer Kafka kehilangan pesan yang terbit selama service mati**, di partisi yang belum punya offset ter-commit (`fromBeginning: false`). Kini `true`. Seluruh consumer idempoten, jadi membaca ulang hanya biaya.
- **Koneksi yang putus setelah terbentuk digolongkan "pasti belum sampai"** di HTTP client supplier-adapters. Akibatnya supplier yang menyimpan pemesanan lalu memutus koneksi akan menghasilkan refund untuk kamar yang tetap ditagih. Galat transport yang tidak dikenali kini jatuh ke sisi tidak pasti.
- **Supplier yang mati setelah pembayaran tidak pernah menghasilkan refund.** `confirm-booking` melaporkan `uncertain` meski setiap percobaan pasti tidak sampai (koneksi ditolak). Kini `failed`, sehingga perintahnya menempuh jenjang retry lalu diumumkan sebagai penolakan, dan saga mengembalikan dana. Ini yang diminta skenario 2.
- **Hold dikirim ulang setelah timeout.** Hold tidak idempoten, jadi percobaan kedua menahan unit kedua. Ditemukan lewat proses yang dibunuh: hold ulang pengguna ditolak SOLD_OUT oleh hold yatim. Operasi yang mengubah keadaan kini hanya dicoba ulang bila permintaannya pasti belum sampai.

### Cacat uji dan perkakas

- **Bom waktu di uji repository booking-service.** Pemesanan contoh HELD memakai `heldUntil` bawaan builder (2026-10-01). Begitu tanggal itu lewat, penyapu di `hold-flow.test.ts` ikut menyapu pemesanan tanpa saga itu dan gagal — tetapi hanya bila berkas repository berjalan lebih dulu. Pemesanan contoh kini diparkir di 2099.
- **`dist` basi.** Satu baris suntikan yang disunting langsung ke hasil build membuat lima skenario gagal berjam-jam, sementara sumbernya benar. Global setup kini membangun keempat service sebelum menyalakan apa pun.
- **"Supplier mati" tampak sebagai koneksi putus** di Docker Desktop Windows. `localhost` mengarah ke ::1, dan penerus wslrelay masih menerima koneksi sebentar setelah kontainer berhenti. Alamat mock kini `127.0.0.1`.
- **Uji pengiriman ulang tidak menangkap catatan `consumed_messages` yang tidak ditulis**, karena mesin keadaan juga menolak duplikatnya. Ditambah uji untuk pesan yang hanya dijaga catatan itu: pembayaran yang tiba setelah EXPIRED.
- **Urutan di skenario "proses mati saat menunggu pembayaran".** Proses dibunuh sebelum outbox sempat menerbitkan harga yang disetujui, sehingga payment-service menolak dengan 409. Niat pembayaran kini dibuat sebelum proses dibunuh, seperti pengguna yang sudah berada di halaman pembayaran.
- **`test.concurrent` hanya serentak di dalam satu `describe`.** Skenario konfirmasi terlambat yang pertama berada di `describe` sendiri. Ia berjalan setelah dua uji lainnya selesai, dan hold-nya sudah kedaluwarsa sebelum dibayar.
- **Proses yatim saat startup gagal.** Satu service yang gagal menyala meninggalkan service lain berjalan di bawah berkas uji berikutnya. Kini semuanya dimatikan sebelum galatnya dilempar.
- **Empat penundaan tetap di uji integrasi Step 17 dan 19.** Diganti polling. Dua di antaranya membuktikan "tidak terjadi apa-apa" dengan menunggu satu detik — lulus sama baiknya bila handler belum sempat berjalan. Kini menunggu offset consumer group ter-commit dan memeriksa outbox.

- **Putaran CI pertama gagal di `hold-flow.test.ts`.** Uji penyapu membandingkan jumlah di laporan penyapu dengan 1, padahal penyapu menyapu SEMUA hold yang lewat di basis data bersama. Dengan urutan berkas yang berbeda di runner Linux, jumlahnya 6. Kini yang diperiksa hanya pemesanan uji itu sendiri, lewat jejak peristiwanya. Lokal lewat dengan `--sequence.shuffle`.

### Belum terjelaskan: 0xC0000409

Dalam empat putaran penuh rangkaian saga hari ini, dua kali sebuah proses node keluar dengan kode 3221226505 (`STATUS_STACK_BUFFER_OVERRUN`, `abort()` di Windows) dengan stderr kosong. Sekali pekerja Vitest saat `crash-recovery`, sekali booking-service saat startup. Tidak ada jejak di Windows Event Log. Kedua kali, berkas yang sama lewat saat dijalankan ulang.

Pada putaran 2026-09-29, kode yang sama muncul ketika stack `pnpm infra:up` berjalan berdampingan dengan kontainer Testcontainers, dan dugaan saat itu adalah tekanan sumber daya. Kali ini stack itu tidak berjalan, jadi dugaan tersebut belum terbukti dan juga belum gugur.

Harness kini menunggu `close` alih-alih `exit` — `exit` dapat terbit sebelum stderr selesai dikuras — dan menyertakan 30 baris log terakhir. Kemunculan berikutnya akan membawa penyebabnya. Sampai itu terjadi, klaim "tidak flaky" belum dapat dibuat di mesin ini.

### Utang yang dicatat

- **Satu pemesanan HELD tanpa saga menghentikan seluruh putaran penyapu.** `expire-hold` melempar, dan loop `sweepHolds` berhenti di pemesanan itu. Sejak Step 19 keadaan ini tidak dapat terbentuk lewat kode produksi, tetapi satu baris rusak akan menahan seluruh kedaluwarsa hold. Tidak diubah di step ini.
- **`TimeoutNegativeWarning` dari kafkajs 2.2.4** (`RequestQueue.scheduleCheckPendingRequests`: `throttledUntil = -1` dikurangi `Date.now()` saat antrian kosong). Cacat di pustaka dan tidak berbahaya: Node membulatkannya menjadi 1 ms. Tidak ditambal; kafkajs tidak lagi dirawat — bahan ADR Step 29.
- **CI belum pernah berjalan.** Workflow di-commit tanpa pernah dijalankan; putaran pertama di GitHub Actions adalah bukti yang masih kurang.
