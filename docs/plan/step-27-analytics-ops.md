# Step 27 — analytics-service dan panel operator

**Fase 5** · Milestone 6 · Estimasi 8 jam · Prasyarat: Step 26 · Q6 sudah dijawab: aplikasi terpisah

## Tujuan

Menunjukkan bahwa aliran peristiwa Kafka punya konsumen sungguhan, dan menyediakan alat bagi operator. Ini step yang paling boleh dipangkas bila waktu menipis.

## Prompt

```
Buat apps/analytics-service dan panel operator.

Baca terlebih dahulu PRD FR-29 sampai FR-33, keputusan Q6, dan
docs/plan/DESIGN-SYSTEM.md.

=== analytics-service ===

1. Consumer peristiwa
   - Mengonsumsi seluruh topik Kafka sebagai pembaca independen
   - Consumer group terpisah, sehingga tidak mengganggu alur utama
   - Ini demonstrasi nyata keunggulan Kafka: menambah konsumen baru tanpa
     menyentuh satu pun service yang sudah ada

2. Agregasi
   - Corong konversi: pencarian, lihat detail, hold, bayar, konfirmasi
   - Performa supplier: latensi, tingkat kegagalan, kontribusi hasil,
     tingkat perubahan harga
   - Kota dan rentang tanggal terpopuler
   - Tingkat kegagalan pemesanan beserta sebabnya
   - Simpan agregat di PostgreSQL. Jangan memakai ClickHouse — lihat
     PRD Bab 12 soal menghindari perkakas yang belum dibutuhkan

3. Replay
   - Sediakan cara membangun ulang seluruh agregat dari awal topik
   - Ini bukti konkret kemampuan replay Kafka, dan layak disebut di ADR
   - Buktikan dengan menghapus agregat lalu membangunnya kembali

=== Panel operator ===

Keputusan Q6: aplikasi Next.js terpisah di apps/ops, berbagi packages/ui
dengan apps/web supaya tampilannya konsisten.

Alasan pemisahan, dan ini yang harus ditegakkan: kode operator tidak boleh
pernah ikut terkirim ke bundel yang diakses publik. Batas keamanannya fisik,
bukan sekadar pemeriksaan peran. Konsekuensinya apps/ops di-deploy terpisah
dan tidak perlu diakses publik.

4. Halaman yang dibutuhkan
   - Kesehatan supplier (FR-31): latensi, tingkat galat, keadaan pemutus
     sirkuit, secara langsung
   - Konfigurasi supplier (FR-29): aktifkan, nonaktifkan, ubah pengaturan
   - Aturan markup (FR-30): CRUD dengan pratinjau dampak
   - Daftar pemesanan NEEDS_REVIEW dengan seluruh konteksnya: riwayat
     booking_events, catatan permintaan supplier, dan status pembayaran.
     Halaman ini yang membuat keadaan NEEDS_REVIEW benar-benar dapat
     ditindaklanjuti, bukan sekadar tempat pembuangan
   - Panel kendali mock-supplier (FR-32): antarmuka untuk menyuntikkan
     latensi dan kegagalan. Ini yang akan kamu pakai saat demo

5. Desain
   - Fungsional, tidak perlu dipoles. Ikuti token dan primitif yang sama
     supaya tetap konsisten, tetapi jangan investasikan waktu pada tampilan
   - Tabel padat boleh di sini, tidak seperti di aplikasi pengguna
   - Akses dibatasi peran operator, diperiksa di gateway dan di service

Commit: feat: add analytics service and operator panel
```

## Definisi Selesai

- [x] analytics-service mengonsumsi peristiwa tanpa mengganggu alur utama. Ia memakai consumer group sendiri (`analytics-service`), tidak punya produsen Kafka, dan pesan cacat hanya dicatat, tidak dikirim ulang ke dead letter. Terbukti terhadap Kafka 3.9.1 dan Postgres 16 native di `tests/integration/replay.test.ts`: offset group lain tidak bergeser dan offset akhir `tbe.dead-letter.v1` tidak berubah. BELUM terbukti saat seluruh service alur pemesanan berjalan bersamaan.
- [x] Agregat dapat dibangun ulang dari awal topik — dibuktikan dengan menghapus lalu membangun ulang, dua kali:
  - Di uji integrasi: bangun, replay ditolak selama consumer hidup, hapus, bangun ulang, hasil sama persis.
  - Ujung ke ujung dengan `pnpm replay` produksi terhadap service yang hidup: ditolak dengan exit 1 saat service menyala. Setelah service dihentikan, tabel kosong dalam 49 detik. Setelah service dinyalakan, ringkasan dari panel sama persis dengan sebelumnya (66 peristiwa).
  - Batas: replay hanya mencakup yang masih ditahan broker (retensi 7 hari untuk topik pencarian, lihat Temuan).
- [x] Halaman kesehatan supplier menampilkan keadaan pemutus sirkuit secara langsung: per operasi, polling tiap 3 detik. Terbukti terhadap palsuan (uji komponen dan uji rute supplier-service). BELUM dilihat terhadap supplier-service yang hidup — service itu tidak dijalankan di container ini.
- [x] Halaman `NEEDS_REVIEW` menampilkan seluruh konteks: alasan dan asal tinjauan, jejak `booking_events`, keadaan saga, status pembayaran beserta refund, dan catatan permintaan supplier lewat kunci idempotensi. Rute booking diuji di atas dunia saga sungguhan (memory DB), halaman diuji dengan fetch palsuan. BELUM ujung ke ujung dengan booking-, payment-, dan supplier-service hidup. Halaman ini hanya membaca: tindakan atas pemesanan belum ada.
- [x] Panel kendali mock-supplier dapat dipakai menyuntikkan kegagalan saat demo. Ujung ke ujung lewat panel → gateway → mock supplier sungguhan: SKY dimatikan (`down: true`), lalu dinyalakan. Permintaan lintas asal ditolak 403.
- [x] Akses operator diperiksa di gateway dan di service, bukan hanya disembunyikan di antarmuka. Ujung ke ujung dengan proses sungguhan:
  - Token pelanggan yang sah, ditambah header `x-tbe-user-role: operator` palsu, dijawab gateway 403.
  - Header pelanggan langsung ke analytics-service tanpa gateway dijawab 403.
  - Akun pelanggan ditolak saat masuk ke panel, dan sesinya dicabut di auth-service.
  - Unit: setiap router `/ops` di enam service, ditambah injeksi pada masing-masing.
- [x] Commit terbuat

## Bukti

Lingkungan: container cloud tanpa Docker. Postgres 16.13 di :5440, Kafka 3.9.1 (KRaft) di :29092, dan Redis 7 di :6390, semuanya native. Node 22.23.5 (repo meminta ≥ 24; hanya peringatan engine).

| Perintah                                                                                                             | Hasil                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm build` · `pnpm typecheck` · `pnpm lint`                                                                        | lulus                                                                                                                                                                                      |
| `pnpm test -- --sequence.shuffle`                                                                                    | lulus. Baru atau berubah di step ini: shared-kernel 135, auth 85, gateway 85, supplier 124, pricing 93, booking 966, payment 254, mock-supplier 133, **analytics 40**, **ops 59**, web 427 |
| Cakupan baru                                                                                                         | analytics: baris 100%, cabang 97,2% (domain 95,9%). ops: baris 94,1%, cabang 88,2%. pricing: 100%. Ambang tidak diturunkan                                                                 |
| `pnpm --filter @tbe/analytics-service test:integration` (env `INTEGRATION_*`, `TZ=America/Los_Angeles`, urutan acak) | 7 lulus, tiga kali dengan seed berbeda                                                                                                                                                     |
| CI `integration` di PR #13 (Testcontainers, runner GitHub)                                                           | lulus; analytics 7/7, replay 47 s                                                                                                                                                          |
| `pnpm verify:boundaries/tokens/contrast/money/catalog`                                                               | lulus. `verify:tokens` kini memindai `packages/ui` dan `apps/ops`                                                                                                                          |
| `pnpm format:check`                                                                                                  | lulus setelah `next-env.d.ts` yang ditulis ulang `next build` dipulihkan                                                                                                                   |
| Migrasi auth (`init` + `add_user_role`) dan analytics                                                                | `prisma migrate deploy` ke Postgres sungguhan                                                                                                                                              |
| `operator:grant`                                                                                                     | berhasil untuk surel huruf besar. Surel tak dikenal: exit 1                                                                                                                                |

Ujung ke ujung (proses `node dist/index.js` dan `next start`): auth-service, api-gateway, analytics-service, mock-supplier, apps/ops. Tanpa sesi, `/` dialihkan (307) ke `/masuk`. Skenario sesudahnya tercatat di butir DoD di atas.

### Injeksi pelanggaran

Setiap penjaga dirusak dengan sengaja, uji terkait harus GAGAL, lalu berkas dipulihkan dan `git status` dipastikan bersih.

| #   | Pelanggaran yang disuntikkan                             | Uji yang menolak                                                                                            |
| --- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| I1  | `requireOperator` tidak memeriksa peran                  | shared-kernel: pelanggan dan identitas tanpa peran harus 403                                                |
| I2  | Gateway tidak memeriksa `requiredRole`                   | gateway: pelanggan 403, header peran palsu tidak menolong                                                   |
| I3  | Verifier meneruskan klaim `role` apa adanya              | gateway: peran tak dikenal dibaca pelanggan                                                                 |
| I4  | Akun baru lahir sebagai operator                         | auth: pendaftaran publik selalu pelanggan                                                                   |
| I5  | Router `/ops/suppliers` tanpa `requireOperator`          | supplier: 401/403, konfigurasi tak berubah                                                                  |
| I6  | Pratinjau memakai `listActive` alih-alih `listAll`       | pricing: mengaktifkan kembali aturan nonaktif                                                               |
| I7  | Antrean tinjauan diurutkan `updatedAt desc`              | booking: yang paling lama menunggu lebih dulu                                                               |
| I8  | Router `/ops/bookings` tanpa penjaga                     | booking: pemilik pemesanan pun 403                                                                          |
| I9  | Router `/ops/payments` tanpa penjaga                     | payment: 401/403                                                                                            |
| I10 | `/ops/mock-supplier` tanpa penjaga                       | mock: 401/403, supplier tetap menyala                                                                       |
| I11 | Replay mengosongkan tabel SEBELUM memutar offset         | analytics: kegagalan di tengah tidak menghilangkan agregat                                                  |
| I12 | Router `/ops/analytics` tanpa penjaga                    | analytics: 401/403                                                                                          |
| I13 | Deduplikasi `event_id` dibuang                           | integrasi: 10 penulis atas pesan sama → 1                                                                   |
| I14 | `value = EXCLUDED.value` (menimpa, bukan menambah)       | integrasi: 50 penulis serentak → 50                                                                         |
| I15 | Pencatatan tanpa transaksi                               | integrasi: kegagalan di tengah tidak meninggalkan pesan "terhitung"                                         |
| I16 | Proksi panel menerima segmen `..`                        | ops: jalur di luar `/ops` 400                                                                               |
| I17 | Pemeriksaan asal dimatikan                               | ops: penulisan lintas asal ditolak                                                                          |
| I18 | Login panel tidak memeriksa peran                        | ops: pelanggan ditolak dan sesinya dicabut                                                                  |
| I19 | Warna mentah di `packages/ui` dan di `apps/ops`          | `verify:tokens` exit 1 untuk keduanya                                                                       |
| I20 | `@source` dibuang dari CSS panel                         | build tetap lulus, tetapi kelas primitif (`pointer-coarse:`) hilang dari CSS — dibandingkan sebelum/sesudah |
| I21 | Consumer analitik memakai produsen dead letter sungguhan | integrasi replay: offset akhir dead letter berubah (baris 201)                                              |

## Temuan

### Keputusan dan alternatif yang ditolak

- **Peran di klaim JWT, diperiksa dua kali.** Gateway memeriksa `requiredRole` per rute. Service memeriksa header `x-tbe-user-role` dengan `requireOperator` dari shared-kernel, karena gateway hanyalah satu jalan masuk. Yang ditolak:
  - Verifikasi JWT di setiap service: sembilan service jadi memegang rahasia.
  - Tabel peran dan izin: hanya ada dua peran.
  - Endpoint "jadikan operator": operator pertama tidak dapat lahir dari rute yang menuntut operator. Gantinya skrip `operator:grant`.
- **Satu awalan `/ops`, diteruskan apa adanya.** Penulisan ulang `/ops/x` menjadi `/internal/x` ditolak: rute `/internal` sengaja tanpa identitas, dan satu kesalahan tabel akan membukanya ke luar.
- **Panel tanpa token di peramban.** Panel memanggil rute server (`/api/ops/*`) yang menyisipkan token dari cookie httpOnly. Ditolak: pola apps/web (access token di memori halaman) — panel ini tidak butuh JavaScript yang memegang token.
- **Agregat sebagai penghitung tunggal** `(hari, metrik, dimensi)`. Ditolak tabel per laporan dan ClickHouse (PRD Bab 12). Replay dengan consumer group baru (biru/hijau) juga ditolak, karena butuh tabel agregat berversi untuk tujuan yang sama.
- **Pratinjau markup di memori, dengan mesin harga yang sama** (`pricerFor`). Ditolak: menyimpan aturan nonaktif lalu "mengaktifkannya untuk pratinjau", karena itu menulis ke tabel yang dibaca setiap pencarian.
- **Kesehatan dari `supplier_requests`, bukan Prometheus.** Prometheus mungkin tidak ada di tingkat gratis Step 30.
- **Polling, bukan SSE**, untuk panel. Pengguna panel hanya satu-dua operator.
- **`packages/ui` sebagai paket sumber** (`exports` ke `.tsx`, `transpilePackages`), tanpa langkah build.

### Utang lama yang ditemukan dan ditutup

- **auth-service tidak punya migrasi sama sekali** (sejak Step 07). Dibuat `init` dari skema Step 07, ditambah `add_user_role`. Basis data yang dibuat sebelum Step 27 perlu `prisma migrate resolve --applied 20261025000000_init` lebih dulu. Langkah itu ditulis di README tetapi BELUM dijalankan terhadap basis data lama.
- **Komentar yang salah.** Komentar di `supplier-routes.ts` dan `pricing-routes.ts` mengklaim rute konfigurasi "dilindungi peran operator di api-gateway". Saat itu gateway belum mengenal peran dan tidak punya rute ke sana. Komentarnya diperbaiki.
- **`packages/ui` belum ada**, padahal Q6 menyebutnya. Primitif, `cn`, dan token dipindahkan dari apps/web tanpa mengubah perilaku: 427 uji web tetap lulus dan build menghasilkan kelas yang sama.

### Yang diminta prompt tetapi tidak ada

- **"Lihat detail" di corong.** Tidak ada peristiwa untuk itu. Menambahkannya berarti mengubah search-service dan apps/web — bertentangan dengan "tanpa menyentuh service yang sudah ada".
- **Latensi per supplier di analitik.** `search.performed` hanya membawa latensi total. Latensi per supplier tersedia di halaman kesehatan.
- **Kontribusi hasil per supplier.** Peristiwa hanya menyebut supplier mana yang menjawab, bukan jumlah hasilnya.
- **Pratinjau dampak atas "seluruh harga"** tidak mungkin: pricing-service tidak menyimpan harga. Pratinjau memakai sampel per supplier yang dipilih operator.

### Bug yang ditemukan uji

- **Replay "macet" di uji integrasi.** `admin.resetOffsets` kafkajs menulis offset lewat consumer sementara yang bergabung ke group, sekitar 8 detik per topik. Versi pertama uji membungkus replay dalam `waitFor`. Percobaan ulang menimpa percobaan yang belum selesai, dan anggota sementaranya tertinggal di group (`Stable`, 1 anggota). Perbaikannya: tunggu group kosong, lalu replay sekali, dengan batas waktu yang jujur.
- **Bangun ulang tidak pernah dianggap selesai.** `resetOffsets({ earliest: true })` menulis penanda `-2`, dan partisi kosong tidak pernah di-commit ulang consumer. Fungsi `caughtUp` di uji kini membaca offset negatif sebagai `low`.
- **Penerjemah peristiwa pertama berupa `switch` dengan `default`** yang mengurai payload dengan skema `booking.cancelled`. Jenis `booking.*` baru di kontrak akan melempar galat dan menahan partisi selamanya. Kini berupa tabel `Record<EventType, …>`: jenis baru tanpa baris gagal dikompilasi.

### Kesalahan saya sendiri

- **Seluruh pekerjaan Step 27 percobaan pertama hilang.** Container dibuat ulang sebelum satu pun commit. Kali ini setiap bagian di-push ke branch kerja segera setelah lulus.
- **Berkas migrasi analytics tercemar keluaran `pnpm install`** akibat rangkaian perintah yang salah urut. Tertangkap oleh `migrate deploy` di global setup uji integrasi (galat sintaks SQL), lalu dibangkitkan ulang.
- **`pkill` yang terlalu luas saat uji ujung ke ujung** ikut mematikan api-gateway, bukan hanya analytics-service. Ketahuan dari health check dan dinyalakan ulang. Hasil replay tidak terpengaruh, karena perbandingannya dilakukan setelah semuanya hidup kembali.

### Utang

- **Halaman tinjauan hanya membaca.** Belum ada konfirmasi atau refund manual dari panel.
- **Pencabutan peran operator tidak seketika.** Token yang sedang hidup membawa peran lama paling lama `ACCESS_TOKEN_TTL_SECONDS` (15 menit).
- **`/admin` mock supplier tanpa peran.** Tidak boleh dapat dijangkau dari luar saat deploy (Step 30).
- **Log yang menyesatkan.** Pembungkus consumer @tbe/messaging menulis `error` "peristiwa cacat dikirim ke dead letter", padahal analitik tidak mengirim apa pun. Pengamat menambahkan baris `warn` yang benar, tetapi pesan aslinya tetap muncul. Memperbaikinya berarti mengubah paket bersama.
- **Retensi 7 hari** untuk `tbe.search.v1` dan `tbe.supplier.v1` membatasi replay. Agregat pencarian yang lebih tua hilang setelah replay.
- **`analytics_processed_events` tumbuh tanpa batas.** Belum ada pemangkasan; replay mengosongkannya.
- **Belum dijalankan:**
  - Panel terhadap supplier-, pricing-, booking-, dan payment-service yang hidup.
  - Tampilan panel di peramban sungguhan: yang diperiksa hanya HTML dan status HTTP, tanpa tangkapan layar.
  - Uji Playwright.

## Catatan

Panel kendali mock-supplier terlihat seperti alat internal, tetapi saat demo ia menjadi bintangnya: kamu matikan satu supplier di depan penilai, lalu tunjukkan pencarian tetap jalan dan pemesanan tetap direfund. Itu lebih meyakinkan daripada tabel angka mana pun.
