# Step 19 — Saga dan kompensasi

**Fase 3** · Milestone 4 · Estimasi 8 jam · Prasyarat: Step 18

## Tujuan

Step paling bernilai di seluruh project. Menjamin bahwa setiap alur pemesanan berakhir di keadaan final, dan tidak ada pengguna yang kehilangan uang. Ini memenuhi G3, NFR-06, dan US-03.

## Prompt

```
Implementasikan orkestrasi saga pemesanan di apps/booking-service.

Baca terlebih dahulu:
- PRD Bab 2.2 masalah 3, G3, NFR-06, NFR-07, NFR-10, US-03, US-05
- Step 16 state machine yang sudah dibuat
- docs/plan/CONVENTIONS.md

Tulis test lebih dulu. Setiap jalur kompensasi wajib punya test.

1. Orkestrator saga
   - Pola orkestrasi, bukan koreografi. booking-service yang memegang kendali
   - Definisikan setiap langkah sebagai data: nama, aksi, aksi kompensasi,
     dan apakah boleh dicoba ulang
   - Langkah alur bahagia:
     1. priceCheck
     2. holdLocal
     3. holdSupplier
     4. awaitPayment
     5. confirmSupplier
     6. issueVoucher
   - Setiap langkah punya kompensasi:
     holdLocal      -> lepaskan kunci Redis
     holdSupplier   -> batalkan hold di supplier
     awaitPayment   -> refund
     confirmSupplier-> batalkan pemesanan di supplier lalu refund

2. Persistensi keadaan saga
   - Tabel saga_states: id, bookingId, currentStep, stepStatus,
     compensationStatus, attempts, lastError, updatedAt
   - Keadaan saga disimpan SEBELUM langkah dijalankan, bukan sesudah.
     Proses yang mati di tengah harus dapat dipulihkan
   - Saat startup, pulihkan saga yang tertinggal di keadaan tidak final

3. Pola outbox
   - Peristiwa Kafka tidak diterbitkan langsung di dalam transaksi bisnis
   - Simpan ke tabel outbox dalam transaksi yang sama dengan perubahan keadaan
   - Penerbit terpisah membaca outbox dan menerbitkan ke Kafka
   - Ini yang mencegah keadaan berubah tanpa peristiwa terbit, atau sebaliknya
   - Penerbit menjamin pengiriman minimal sekali; consumer harus idempoten

4. Alur kompensasi (US-03)
   - payment.succeeded memicu perintah supplier.confirm lewat RabbitMQ
   - Kegagalan yang boleh dicoba ulang mengikuti retry berjenjang dari Step 05
   - Kegagalan permanen setelah retry habis:
     terbitkan booking.failed, jalankan kompensasi berurutan mundur,
     kirim perintah payment.refund, lepaskan hold, pindahkan ke FAILED
     lalu REFUNDED setelah refund berhasil
   - Kegagalan kompensasi TIDAK boleh diabaikan. Setelah retry habis,
     pindahkan ke NEEDS_REVIEW dan catat galat tingkat error

5. Penanganan ketidakpastian (US-05)
   - Timeout pada confirmSupplier tidak boleh langsung dianggap gagal
   - Gunakan mekanisme dari Step 11: pastikan status sebenarnya lewat getBooking
   - Bila status tetap tidak dapat dipastikan setelah beberapa percobaan,
     pindahkan ke NEEDS_REVIEW, JANGAN refund secara membabi buta —
     refund untuk pemesanan yang sebenarnya berhasil menciptakan kerugian
     jenis lain

6. Jaminan yang harus dipenuhi
   - Setiap saga berakhir di keadaan final dalam waktu terbatas
   - Tidak ada pembayaran berhasil tanpa pemesanan terkonfirmasi atau refund
   - Tidak ada pemesanan terkonfirmasi tanpa pembayaran berhasil
   - Seluruh perubahan tercatat di booking_events untuk audit (NFR-10)

7. Antarmuka status
   - GET /bookings/:id/status
   - Endpoint SSE yang memancarkan perubahan status secara langsung,
     untuk dipakai di Step 21

Test yang wajib, masing-masing dengan skenario kegagalan disuntikkan:
- Alur bahagia mencapai CONFIRMED
- Supplier gagal permanen setelah pembayaran: mencapai REFUNDED, hold terlepas
- Pembayaran gagal setelah hold: hold terlepas, mencapai CANCELLED
- Timeout pada konfirmasi: getBooking dipanggil, bukan konfirmasi ulang
- Status tidak dapat dipastikan: mencapai NEEDS_REVIEW tanpa refund
- Kompensasi gagal: mencapai NEEDS_REVIEW dengan galat tingkat error
- Proses dimatikan di tengah saga lalu dihidupkan: saga dipulihkan dan selesai
- Outbox: perubahan keadaan dan penerbitan peristiwa selalu konsisten
- Peristiwa yang sama dikonsumsi dua kali tidak menghasilkan efek ganda

Jalankan /code-review setelah selesai. Ini kode paling kritis di project,
perbaiki seluruh temuan CRITICAL dan HIGH.

Commit: feat: add booking saga with compensation
```

## Definisi Selesai

- [x] Setiap langkah punya kompensasi yang terdefinisi sebagai data — `SAGA_DEFINITION` di `domain/saga-definition.ts`; "tidak ada" dan "habis sendiri" juga pernyataan wajib beserta alasannya. Pelaksana kompensasi generik dikemudikan tabel; aksi tanpa implementasi adalah galat compiler. Suntikan G7
- [x] Keadaan saga disimpan sebelum langkah dijalankan — niat hold lokal dan hold supplier dicatat dengan sewa sebelum Redis/supplier disentuh; kompensasi langsung dicatat lewat penunjuk sebelum dijalankan. Suntikan G1 — terbukti terhadap palsuan dengan proses mati disimulasikan
- [x] Saga yang tertinggal dipulihkan saat startup — dibuktikan dengan test mematikan proses di tengah: penyapu saga berjalan di dalam `start` sebelum consumer dan HTTP, lalu berkala; tiga titik mati (setelah kursi lokal diambil, setelah hold supplier, setelah FAILED tersimpan) dipulihkan dan selesai (CONFIRMED / REFUNDED). Proses mati disimulasikan dengan galat yang tidak ditangkap + dependensi baru di atas basis data dan Redis yang sama; **BELUM** dengan proses OS yang benar-benar dibunuh (Step 20)
- [x] Pola outbox menjamin konsistensi perubahan keadaan dan penerbitan peristiwa — outbox di transaksi yang sama, terbukti terhadap palsuan (dengan tandingan tanpa rollback) DAN terhadap Postgres sungguhan; penerbit terbukti mengirim ke Kafka dan RabbitMQ sungguhan dengan eventId = id baris. Suntikan G2, G3, G3b, G10, G11
- [x] Kegagalan supplier setelah pembayaran menghasilkan refund otomatis — US-03 sampai REFUNDED, hold lokal terlepas; `payment.refund` terbukti tiba di RabbitMQ sungguhan. payment-service yang mengerjakannya tidak berjalan dalam uji ini (Step 20)
- [x] Ketidakpastian status menghasilkan `NEEDS_REVIEW`, bukan refund membabi buta — jawaban `uncertain` DAN tidak ada jawaban sampai batas waktu; terbukti tidak ada `payment.refund` di RabbitMQ sungguhan. Suntikan G4, G4b, G12
- [x] Kegagalan kompensasi menghasilkan `NEEDS_REVIEW` dan galat tingkat error — refund tak terkonfirmasi sampai batas waktu, dan kompensasi langsung yang gagal sampai percobaan habis; tingkat log diperiksa dari keluaran pino sungguhan. Suntikan G5, G5b
- [x] Peristiwa yang dikonsumsi dua kali tidak menghasilkan efek ganda — `consumed_messages` dalam transaksi efeknya; terbukti terhadap palsuan, Postgres sungguhan (dua transaksi serentak), dan Kafka sungguhan (pesan yang sama diterbitkan dua kali). Suntikan G6, G6b
- [x] Endpoint SSE memancarkan perubahan status — `GET /bookings/stream/:id` (awalan streaming gateway Step 08) dan `GET /bookings/:id/status`; diuji lewat aplikasi HTTP yang sama dengan produksi. **BELUM** lewat api-gateway sungguhan
- [x] Cakupan jalur kompensasi 100% — ambang 100% untuk `domain/saga-*.ts`, `application/saga/**`, `infrastructure/unit-of-work.ts`, ditegakkan di `vitest.config.ts`. Cakupan diukur suite unit (palsuan); jalur yang sama dijalankan ulang terhadap infrastruktur sungguhan di tests/integration — lihat Temuan tentang pertentangan CONVENTIONS bagian 10
- [x] `/code-review` dijalankan dan temuan CRITICAL serta HIGH ditutup — lihat bagian Code review
- [x] Commit terbuat — `feat: add booking saga with compensation`

## Catatan

Keputusan untuk tidak melakukan refund saat status tidak dapat dipastikan adalah bagian paling menarik dari step ini. Refund otomatis terdengar lebih ramah, tetapi bila pemesanan sebenarnya berhasil, platform menanggung biaya kamar yang tetap terpakai. Catat pertimbangan ini sebagai ADR — pertanyaan seperti ini yang membedakan engineer yang memikirkan konsekuensi bisnis.

## Bukti

### Infrastruktur

Docker Desktop HIDUP di mesin ini (pertama kali sejak Step 05). `pnpm infra:up` menyalakan PostgreSQL 16.15, Redis 7, Kafka, dan RabbitMQ. Satu penyesuaian: port 5433 dan 5434 dipakai Postgres native Windows, jadi kontainer Postgres dijalankan dengan `POSTGRES_PORT=5439` untuk sesi ini (`infra/.env` tidak diubah).

### Suntikan

Tujuh belas suntikan, diterapkan dan dipulihkan oleh skrip di luar repo; setiap berkas dibandingkan byte demi byte dengan isinya sebelum suntikan, dan seluruh sumber lalu dibandingkan dengan arsip cadangan (`diff -r`, kosong).

| #   | Pelanggaran yang disuntikkan                                            | Diperiksa terhadap               | Hasil        | Uji gagal |
| --- | ----------------------------------------------------------------------- | -------------------------------- | ------------ | --------- |
| G1  | Keadaan saga disimpan SESUDAH hold lokal, bukan sebelum                 | unit (proses mati disimulasikan) | GAGAL (baik) | 2         |
| G2  | Peristiwa tidak lewat outbox di transaksi bisnis                        | unit                             | GAGAL (baik) | 14        |
| G3  | `booking.created` ke outbox di transaksi terpisah dari pemesanan        | unit (palsuan dengan rollback)   | GAGAL (baik) | 1         |
| G3b | Perintah outbox di transaksi terpisah dari unit kerja saga              | **Postgres sungguhan**           | GAGAL (baik) | 1         |
| G4  | Timeout `confirmSupplier` langsung dianggap gagal lalu refund           | unit                             | GAGAL (baik) | 1         |
| G4b | Jawaban `uncertain` dianggap penolakan lalu refund                      | unit                             | GAGAL (baik) | 1         |
| G5  | Refund tak terkonfirmasi diabaikan: saga dianggap selesai               | unit                             | GAGAL (baik) | 3         |
| G5b | Kompensasi langsung yang gagal ditelan                                  | unit                             | GAGAL (baik) | 2         |
| G6  | Catatan pesan terkonsumsi tidak ditulis                                 | unit                             | GAGAL (baik) | 1         |
| G6b | G6 dengan dua transaksi serentak                                        | **Postgres sungguhan**           | GAGAL (baik) | 2         |
| G7  | Langkah `holdLocal` tanpa kompensasi terdefinisi                        | unit                             | GAGAL (baik) | 13        |
| G8  | Berkas suntikan: domain mengimpor infrastructure                        | eslint                           | GAGAL (baik) | 1 galat   |
| G9  | Pemulihan tidak menghormati sewa                                        | unit                             | GAGAL (baik) | 1         |
| G10 | Penerbit outbox melompati pesan yang gagal alih-alih berhenti           | unit                             | GAGAL (baik) | 1         |
| G11 | Penerbit outbox tanpa kunci penasihat                                   | **Postgres sungguhan**           | GAGAL (baik) | 2         |
| G12 | supplier-service: dead letter karena galat apa pun diumumkan `rejected` | unit supplier-service            | GAGAL (baik) | 1         |
| G13 | @tbe/messaging: kabar dead letter yang gagal membuang pesan             | unit messaging                   | GAGAL (baik) | 1         |

Keluaran G8:

```
apps/booking-service/src/domain/__injected-boundary.ts
  1:28  error  domain tidak boleh mengimpor dari infrastructure  boundaries/element-types
```

Skrip suntikan menghitung 2 baris galat saat melint seluruh `src/domain`; diperiksa ulang sendirian, berkas suntikan menghasilkan satu galat di atas. Selisihnya tidak ditelusuri lebih jauh.

### Uji

- booking-service: **657 uji unit**, tiga kali dengan `--sequence.shuffle`. Cakupan 99,91% pernyataan, 99,85% cabang, 100% fungsi, 100% baris; jalur kompensasi 100%.
- booking-service: **56 uji integrasi** terhadap PostgreSQL 16.15, Redis 7, Kafka, dan RabbitMQ sungguhan; di `Asia/Jakarta` dan `America/Los_Angeles`, dengan urutan acak.
- supplier-service, @tbe/messaging, @tbe/event-contracts: uji jawaban konfirmasi, kabar dead letter, dan amplop yang ditetapkan outbox.
- Seluruh perintah verifikasi hijau: `install`, `build`, `lint`, `typecheck`, `test`, `verify:money`, `verify:boundaries`, `verify:tokens`, `verify:contrast`, `verify:catalog`, `verify:loadtest`, `test:integration`.

## Temuan

### Blokir yang tidak disebut: hasil `supplier.confirm` tidak pernah kembali

Consumer `supplier.confirm` di supplier-service (Step 11) hanya MENULIS LOG untuk hasil `confirmed` dan `uncertain`, dan melempar untuk penolakan — lalu jenjang retry, lalu dead letter tanpa kabar. Tidak ada peristiwa balasan di kontrak. Tanpa kanal balik, saga tidak pernah dapat mencapai CONFIRMED maupun FAILED. Ditanyakan ke pemilik proyek; keputusan: balasan lewat Kafka.

- event-contracts: `supplier.booking_confirmed`, `supplier.booking_rejected`, `supplier.booking_uncertain` di topik baru `tbe.supplier-booking.v1` (6 partisi, kunci bookingId, 90 hari).
- @tbe/messaging: hook `onDeadLetter`. Kabar yang gagal disampaikan menunda ulang perintah di jenjang terakhir dengan hitungan tetap — bukan `requeue`, yang akan berputar tanpa jeda selama Kafka mati.
- supplier-service: dead letter diumumkan `rejected` HANYA bila galat terakhirnya `SupplierConfirmRejected`. Galat lain — termasuk Kafka yang mati SETELAH `book` berhasil — diumumkan `uncertain`. Versi pertama yang terpikir mengumumkan setiap dead letter sebagai penolakan; itu refund untuk kamar yang sudah terjamin (suntikan G12).

### Keputusan terbuka #1: hold supplier dinyatakan `lapses`

Diputuskan pemilik proyek: kompensasi `holdSupplier` adalah pernyataan `lapses` beserta alasannya, bukan fungsi kosong. Pemulihan mencatat di saga bahwa hold supplier mungkin ada (`lastError`), supaya operator tahu. Pelepasan sungguhan tetap utang lintas lima adapter dan lima supplier simulasi.

### Keputusan terbuka #3: tiruan dan cakupan 100%

CONVENTIONS bagian 10 melarang tiruan untuk jalur kompensasi DAN menuntut cakupan 100%. Karena broker kini tersedia, pertentangannya diselesaikan begini, dan tidak disembunyikan: cakupan 100% diukur suite unit, yang berjalan di atas PALSUAN yang meniru sifat sungguhan (rollback, UNIK, kunci asing, atomisitas Lua) dengan palsuan tandingan yang tidak punya sifat itu. Jalur kompensasi yang sama dijalankan ulang terhadap Postgres, Redis, Kafka, dan RabbitMQ sungguhan di tests/integration, tetapi uji integrasi tidak diukur cakupannya. Yang TIDAK ditiru palsuan — persaingan kunci penasihat, transaksi yang benar-benar serentak, CHECK — hanya diklaim dari uji integrasi.

### Cacat nyata di @tbe/messaging, ditemukan broker sungguhan

`createRabbitConnection` mendeklarasikan topologi di setup kanal, dan `consume` menambah setup lain. amqp-connection-manager 5 menjalankan setup BERSAMAAN (`Promise.all`), jadi consume dapat mendahului deklarasi antrian: RabbitMQ yang masih kosong menutup kanal dengan `404 NOT_FOUND - no queue 'tbe.supplier.confirm'`. Ini juga memengaruhi payment-service dan supplier-service. Tidak pernah terlihat karena consumer ini belum pernah dijalankan terhadap RabbitMQ sejak Step 05. Diperbaiki: setup consume mendeklarasikan topologi dulu (idempoten).

### Keadaan saga bukan keadaan pemesanan, dan keduanya satu transaksi

Unit kerja saga (`SagaUnit`) menulis dalam SATU transaksi: catatan pesan terkonsumsi (lebih dulu, supaya duplikat gagal sebelum apa pun), transisi pemesanan + jejak + padanan outbox-nya, keadaan saga, lalu perintah. Kegagalan kunci versi DILEMPAR di dalam transaksi — mengembalikan nilai berarti commit, dan catatan pesan terkonsumsi akan tersimpan untuk efek yang tidak pernah terjadi.

Fase saga tidak disimpan sebagai kolom sendiri; ia diturunkan dari pasangan `step_status`/`compensation_status` step doc, dan pasangan tak dikenal ditolak. Empat kolom di luar step doc: `compensating_step`, `deadline_at`, `leased_until`, `version`.

### Pemulihan dengan sewa, bukan "semua yang tertinggal saat startup"

Step doc meminta pemulihan saat startup. Dengan beberapa instance (NFR-20), saga yang sedang dikerjakan instance lain juga tampak tertinggal. Setiap langkah langsung membawa sewa; pemulihan hanya mengambil saga yang sewanya lewat, lalu mencatat sewa baru lebih dulu — kunci versi memastikan satu pemulih. Langkah yang hasilnya tidak diketahui dikompensasi seolah berhasil (kompensasinya idempoten), karena hold supplier tidak idempoten dan mengulangnya menahan unit kedua. config.ts menolak sewa yang tidak lebih dari tiga kali `UPSTREAM_TIMEOUT_MS`, dan batas menunggu saga yang tidak lebih lama dari jenjang retry perintah.

### Penerbit outbox: satu pada satu waktu, berhenti pada kegagalan

Ditolak: `FOR UPDATE SKIP LOCKED` dengan beberapa penerbit (membalik urutan per pemesanan), tabel sewa buatan sendiri (tidak dilepas saat proses mati). Dipilih: kunci penasihat transaksi. Harganya: transaksi penerbit terbuka selama satu batch dikirim, dan satu broker yang mati menahan SELURUH outbox — termasuk peristiwa Kafka saat hanya RabbitMQ yang mati. Dicatat sebagai keterbatasan.

### Tidak ada pembayaran berhasil tanpa konfirmasi atau refund — termasuk yang terlambat

Pembayaran yang tidak dapat diterima pemesanan dikembalikan: setelah hold kedaluwarsa, setelah pembatalan, pembayaran kedua, atau nilai lain. `refundRequestId` diturunkan (UUID v8 dari SHA-256 pemesanan + pembayaran), jadi pengiriman ulang dikenali payment-service. Dua celah, dicatat jujur:

- Refund itu DILACAK saga (batas waktu, peninjauan bila tak terkonfirmasi) hanya bila pemesanannya sudah final. Bila belum final, saga sedang menunggu hal lain; refund tetap dikirim dan ketiadaan pelacakan dicatat tingkat error.
- Kontrak `payment.refund` hanya mengenal `supplier_failed`, `user_cancelled`, `manual`. Tidak ada "pemesanan tidak lagi dapat menerima pembayaran"; `manual` dipakai. Menambah nilai berarti migrasi enum payment-service — lebih tepat di Step 25.

### Konfirmasi yang terlambat

Kompensasi `confirmSupplier` (pembatalan di supplier) hanya berjalan untuk konfirmasi yang tiba setelah saga memutuskan lain: uang sedang atau sudah dikembalikan → `supplier.cancel`, dan pemesanan ke peninjauan (FAILED → NEEDS_REVIEW, sesuai tabel Step 16). Pada peninjauan TANPA refund (status tidak pasti), konfirmasi itu justru yang ditunggu pengguna — tidak dibatalkan, faktanya dicatat untuk peninjau. booking reference KEDUA untuk pemesanan yang sudah CONFIRMED juga dibatalkan. `supplier.cancel` tidak punya jalan balik, jadi keberhasilannya tidak dapat dipastikan saga.

### Keputusan terbuka #2

Tidak ada sisi keluar baru dari CONFIRMED. Konfirmasi kedua yang terlambat ditangani tanpa mengubah pemesanan.

### Cakupan menemukan dua cabang yang tidak dapat terbukti benar

- `beginCompensation` punya cabang untuk rencana dengan refund tetapi tanpa kompensasi langsung. Dengan tabel sekarang itu mustahil: refund (`awaitPayment`) selalu didahului `holdLocal`. Fungsi disusun ulang lewat `settle`, yang semua cabangnya tercapai dari pemanggil lain.
- `directCompensationDone` menangani penunjuk di langkah pertama — tidak pernah terjadi karena `priceCheck` tidak punya kompensasi langsung. Diganti pencarian mundur dari penunjuk itu sendiri; `previousStep` yang tak terpakai dihapus.
- `CompensationRequest.supplierRef` tidak pernah diisi siapa pun — dihapus.

### Pengacakan dan pengulangan menemukan ketergantungan tersembunyi

Uji saga integrasi memakai satu slot Redis; kursi pemesanan yang dibayar tertahan 15 menit. Putaran kedua dalam 15 menit menemukan slot penuh oleh sisa putaran pertama (`hold gagal: sold_out`). Diperbaiki dengan mengosongkan Redis di awal berkas — pola yang sama dengan uji hold Step 17.

### Kesalahan sendiri

- Palsuan tandingan hold store (Step 17) kehilangan balapannya: penulisan saga SEBELUM hold lokal menyerialkan permintaan, dan jendela satu mikrotask tidak lagi tumpang tindih — uji "tidak hampa" menjadi hampa. Jendelanya dilebarkan ke satu giliran makrotask, meniru perjalanan jaringan.
- Pengenal pesan di dunia uji dihitung per proses; setelah `restart()` pesan baru memakai eventId pesan sebelum restart dan (dengan benar) ditolak sebagai duplikat. Penghitungnya dipindah ke keadaan bersama.
- Menulis `as never` di dua uji; keduanya diganti (logger sungguhan, aplikasi Express sungguhan).
- `global-setup.ts` uji integrasi memanggil `npx` langsung; di Windows itu `.cmd` dan gagal `ENOENT`. Kini CLI Prisma dijalankan lewat `node`.
- Skrip penyunting Python di Windows menulis dalam mode teks dan mengubah 21 berkas menjadi CRLF; `git diff` tampak menulis ulang berkas utuh. Ketahuan dari jumlah baris terhapus yang tidak masuk akal, lalu dinormalkan ke LF dan diperiksa ulang dengan `--ignore-cr-at-eol`.
- `ERROR_LEVEL` pertama ditulis `50` (angka pino); logger shared-kernel menulis label `error`.

### Code review

`/code-review` (mode lokal) dijalankan atas seluruh perubahan. Tidak ada temuan CRITICAL maupun HIGH. Yang tercatat:

- **MEDIUM — satu baris rusak dapat menahan satu partisi Kafka.** Reaksi saga melempar untuk cacat data (pemesanan berbayar tanpa saga); aturan @tbe/messaging sejak Step 05 menjadikan lemparan itu pembacaan ulang tanpa akhir. Tidak dapat terjadi lewat jalur tulis mana pun di service ini, tetapi skrip perbaikan data dapat membuatnya. Dibiarkan, karena melompati pesan yang belum dikerjakan lebih berbahaya daripada berhenti; dicatat untuk Step 28.
- **MEDIUM — satu broker yang mati menahan seluruh outbox** (lihat bagian penerbit di atas). Keputusan sadar demi urutan.
- **LOW — penangan saga dibuat ulang per pesan di index.ts.** Diperbaiki.
- `pnpm lint` menemukan 25 galat di kode baru saat verifikasi pertama — fungsi lebih dari 50 baris (penerbit outbox, palsuan), parameter lebih dari empat (`settle`), mutasi parameter di palsuan, `throw` bukan Error di uji. Semuanya diperbaiki dengan memecah kode, bukan melonggarkan aturan; satu `eslint-disable` beralasan di uji yang meniru pustaka pihak ketiga yang menolak dengan nilai bukan Error.
- `pnpm verify:money` menolak `refundTimeoutMs: number` — nama berawalan `refund` dianggap nilai uang. Diganti `awaitRefundTimeoutMs`, pengecualian tidak dilebarkan.

### Yang BELUM dijalankan

| Pemeriksaan                                                           | Yang diharapkan                                                                                  |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| supplier-service dan payment-service BERJALAN bersama booking-service | Step 20: saga lintas proses; payment-service menagih dari `booking.created` yang kini terbit.    |
| `index.ts` booking-service dijalankan utuh                            | Startup memulihkan saga sebelum consumer dan HTTP; penutupan berurutan.                          |
| Proses OS dibunuh di tengah saga                                      | Step 20/28. Yang terbukti: galat tak tertangkap + dependensi baru di atas penyimpanan yang sama. |
| SSE lewat api-gateway                                                 | Rute `/bookings/stream` sudah streaming di gateway; belum ujung ke ujung.                        |
| Uji integrasi supplier-service dengan RabbitMQ sungguhan              | Kabar dead letter diumumkan ke Kafka setelah jenjang retry habis.                                |
