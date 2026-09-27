# Step 16 — booking-service: domain dan state machine

**Fase 3** · Milestone 4 · Estimasi 6 jam · Prasyarat: Step 15

## Tujuan

Memodelkan siklus hidup pemesanan sebagai state machine eksplisit sebelum menyentuh integrasi apa pun. NFR-06 melarang keadaan menggantung, dan satu-satunya cara menjamin itu adalah membuat transisi tidak sah menjadi mustahil pada tingkat tipe.

## Prompt

```
Buat apps/booking-service, dimulai dari domain murni tanpa integrasi apa pun.

Baca terlebih dahulu:
- docs/plan/CONVENTIONS.md, terutama bagian 3 soal union diskriminan
- PRD Bab 8 glosarium, NFR-06, NFR-10

Tulis test lebih dulu. Seluruh step ini bisa diuji tanpa database dan tanpa jaringan.

1. State machine pemesanan
   Keadaan:
   - DRAFT        baru dibuat, belum ada apa-apa
   - PRICE_CHECKED harga terverifikasi, menunggu persetujuan bila berubah
   - HELD         inventaris tertahan, menunggu pembayaran
   - PAID         pembayaran diterima, menunggu konfirmasi supplier
   - CONFIRMED    supplier memberi booking reference. Keadaan final
   - FAILED       gagal, kompensasi sedang atau sudah berjalan
   - REFUNDED     dana dikembalikan. Keadaan final
   - CANCELLED    dibatalkan pengguna. Keadaan final
   - EXPIRED      hold kedaluwarsa tanpa pembayaran. Keadaan final
   - NEEDS_REVIEW status supplier tidak dapat dipastikan. Keadaan final
                  yang membutuhkan tindakan manusia

   Ketentuan:
   - Modelkan sebagai union diskriminan. Setiap keadaan hanya membawa data yang
     relevan untuknya. CONFIRMED wajib punya supplierRef; DRAFT tidak boleh punya
   - Definisikan tabel transisi yang sah sebagai data
   - Fungsi transisi mengembalikan Result. Transisi tidak sah adalah galat,
     bukan diabaikan diam-diam
   - Setiap keadaan final tidak punya transisi keluar
   - Buktikan dengan test bahwa dari setiap keadaan tidak final, selalu ada
     jalur menuju keadaan final. Ini yang menjamin NFR-06

2. Entitas dan value object
   - Booking, GuestDetails, BookingLineItem
   - IdempotencyKey sebagai value object
   - Seluruh nilai uang memakai packages/money

3. Peristiwa domain
   - Setiap transisi menghasilkan peristiwa domain
   - Peristiwa domain terpisah dari peristiwa Kafka. Pemetaan ke amplop Kafka
     terjadi di lapisan aplikasi

4. Skema Prisma
   - bookings: id, userId, status, supplierId, supplierRef, propertyId,
     ratePlanRef, checkIn (DATE), checkOut (DATE), guests, amount (integer),
     currency, idempotencyKey unik, heldUntil, createdAt, updatedAt
   - booking_events: id, bookingId, eventType, payload, occurredAt.
     Append only. Ini sumber audit trail untuk NFR-10
   - Perhatikan CONVENTIONS.md bagian 9: checkIn dan checkOut bertipe DATE,
     bukan TIMESTAMP. Ini bukan detail kecil
   - Indeks pada idempotencyKey, userId, status, dan heldUntil

5. Repository
   - Port BookingRepository di application
   - Implementasi Prisma di infrastructure
   - Penyimpanan booking dan booking_events terjadi dalam satu transaksi database

Test yang wajib:
- Seluruh transisi sah berhasil
- Seluruh transisi tidak sah ditolak dengan galat yang jelas
- Dari setiap keadaan tidak final terdapat jalur menuju keadaan final
- Keadaan final tidak punya transisi keluar
- Data yang tidak relevan tidak dapat melekat pada keadaan yang salah,
  dibuktikan lewat pemeriksaan tipe

Jangan menulis integrasi apa pun di step ini. Tanpa Redis, tanpa broker,
tanpa panggilan ke supplier.

Commit: feat: add booking domain and state machine
```

## Definisi Selesai

- [x] Seluruh keadaan dimodelkan sebagai union diskriminan — sepuluh keadaan, dengan bidang milik keadaan lain dinyatakan `?: never`. Dibuktikan tsc: suntikan S6 dan S6b
- [x] Tabel transisi dideklarasikan sebagai data, bukan tersebar di percabangan — `TRANSITIONS` dan `COMMAND_TARGETS`; tidak ada satu pun pemeriksaan `status` di handler. Graf keadaan di uji diturunkan dari kedua tabel itu
- [x] Transisi tidak sah menghasilkan galat, bukan diabaikan — seluruh 86 sel tidak sah diuji satu per satu; suntikan S1 menggagalkan 88 uji
- [x] Terbukti dengan test bahwa tidak ada keadaan buntu yang tidak final — penelusuran graf dari setiap keadaan tidak final, plus finalitas dari dua arah; suntikan S2 dan S3
- [x] `checkIn` dan `checkOut` bertipe `DATE` — terbukti pada teks skema dan migrasi yang dihasilkan offline, dan pada pemetaan kolom yang diuji di zona America/Los_Angeles; BELUM terhadap Postgres sungguhan (migrasi belum pernah dijalankan)
- [x] `booking_events` bersifat append only dan tersimpan dalam transaksi yang sama — transaksi terbukti terhadap palsuan yang meniru rollback, dengan palsuan tandingan tanpa rollback yang membuat uji yang sama gagal; suntikan S5 dan S5b. Append-only ditegakkan port (tidak ada operasi ubah/hapus) dan trigger di migrasi; trigger itu BELUM pernah dijalankan terhadap Postgres sungguhan
- [x] Domain tidak mengimpor apa pun dari infrastruktur — lint membuktikannya: suntikan S7, `domain tidak boleh mengimpor dari infrastructure`
- [x] Cakupan test domain ≥ 95% — 100% pernyataan, cabang, fungsi, dan baris, untuk domain maupun seluruh service. Ambang 95% untuk `src/domain/**` ditegakkan di vitest.config.ts
- [x] Commit terbuat — `feat: add booking domain and state machine`, commit yang memuat dokumen ini

## Catatan

Keadaan `NEEDS_REVIEW` sering dianggap tanda kegagalan desain. Justru sebaliknya: mengakui bahwa sebagian kasus tidak dapat diselesaikan otomatis, dan menyediakan tempat yang jelas untuknya, lebih baik daripada berpura-pura setiap kasus punya jawaban otomatis lalu meninggalkan pemesanan menggantung.

## Bukti

Dua puluh satu suntikan pelanggaran, masing-masing diterapkan, diperiksa, lalu dipulihkan. Skrip yang menjalankannya ada di luar repo (scratchpad sesi); pemulihannya diperiksa dengan membandingkan seluruh `src/`, `prisma/`, dan `vitest.config.ts` terhadap cadangan, dan migrasi yang dihasilkan ulang dibandingkan dengan hash sebelum suntikan. Tabel yang sama ada di README service.

| #    | Pelanggaran yang disuntikkan                                                  | Berkas                                        | Diperiksa | Hasil        | Yang gagal |
| ---- | ----------------------------------------------------------------------------- | --------------------------------------------- | --------- | ------------ | ---------- |
| S1   | Transisi tidak sah dikembalikan `ok` tanpa perubahan                          | `domain/transitions.ts`                       | vitest    | GAGAL (baik) | 88 uji     |
| S2   | Keadaan final CONFIRMED diberi transisi keluar `cancel`                       | `domain/transitions.ts`                       | vitest    | GAGAL (baik) | 5 uji      |
| S3   | Keadaan tidak final FAILED dibuat buntu                                       | `domain/transitions.ts`                       | vitest    | GAGAL (baik) | 24 uji     |
| S4   | `checkIn` menjadi `@db.Timestamptz(3)`, migrasi dihasilkan ulang              | `prisma/schema.prisma`                        | vitest    | GAGAL (baik) | 2 uji      |
| S4b  | `checkOut` menjadi `@db.Timestamp(3)`, migrasi dihasilkan ulang               | `prisma/schema.prisma`                        | vitest    | GAGAL (baik) | 3 uji      |
| S5   | booking_events di transaksi terpisah dari bookings (pembuatan)                | `infrastructure/prisma-booking-repository.ts` | vitest    | GAGAL (baik) | 2 uji      |
| S5b  | booking_events di transaksi terpisah dari bookings (transisi)                 | `infrastructure/prisma-booking-repository.ts` | vitest    | GAGAL (baik) | 2 uji      |
| S6   | Berkas suntikan: DRAFT dengan `supplierRef`                                   | `domain/__injected-draft-ref.ts`              | tsc       | GAGAL (baik) | 1 galat    |
| S6b  | Larangan `?: never` dilepas dari union                                        | `domain/booking.ts`                           | tsc       | GAGAL (baik) | 17 galat   |
| S7   | Berkas suntikan: domain mengimpor infrastructure                              | `domain/__injected-boundary.ts`               | eslint    | GAGAL (baik) | 1 galat    |
| S8   | Price check ulang diizinkan saat perubahan menunggu persetujuan               | `domain/handlers.ts`                          | vitest    | GAGAL (baik) | 1 uji      |
| S9   | Hold diizinkan setelah persetujuan tanpa price check ulang                    | `domain/handlers.ts`                          | vitest    | GAGAL (baik) | 1 uji      |
| S10  | Pembayaran bernilai berbeda dari harga disetujui diterima                     | `domain/handlers.ts`                          | vitest    | GAGAL (baik) | 2 uji      |
| S11  | Kolom DATE ditulis sebagai tengah malam zona mesin                            | `infrastructure/booking-rows.ts`              | vitest    | GAGAL (baik) | 2 uji      |
| S12  | Kolom DATE dibaca dengan `getDate()`                                          | `infrastructure/booking-rows.ts`              | vitest    | GAGAL (baik) | 19 uji     |
| S13  | Zona uji non-UTC dihapus                                                      | `vitest.config.ts`                            | vitest    | GAGAL (baik) | 1 uji      |
| S13b | S11 dan S13 bersamaan                                                         | dua berkas                                    | vitest    | GAGAL (baik) | 1 uji      |
| S14  | Kunci versi diganti "baca versi terbaru lalu tulis"                           | `infrastructure/prisma-booking-repository.ts` | vitest    | GAGAL (baik) | 1 uji      |
| S15  | Tabrakan kunci idempotensi dilempar alih-alih mengembalikan pemesanan pertama | `infrastructure/prisma-booking-repository.ts` | vitest    | GAGAL (baik) | 2 uji      |
| S16  | Nilai peristiwa yang tidak dapat disimpan diubah diam-diam menjadi teks       | `infrastructure/booking-rows.ts`              | vitest    | GAGAL (baik) | 3 uji      |
| S17  | Port `BookingDb` mengklaim kolom yang tidak ada di `PrismaClient`             | `infrastructure/booking-db.ts`                | tsc       | GAGAL (baik) | 5 galat    |

Keluaran suntikan yang diminta secara khusus:

```
S6  src/domain/__injected-draft-ref.ts(5,14): error TS2322: Type '{ id: string; ...; supplierRef: string; }'
    is not assignable to type 'Booking'.

S7  apps/booking-service/src/domain/__injected-boundary.ts
      1:23  error  domain tidak boleh mengimpor dari infrastructure  boundaries/element-types
```

Kedua berkas suntikan dihapus setelah diperiksa.

Seluruh sepuluh perintah verifikasi hijau: `lint`, `typecheck`, `test`, `build`, `verify:money`, `verify:boundaries`, `verify:tokens`, `verify:contrast`, `verify:catalog`, `verify:loadtest`. `pnpm test` menjalankan 19 tugas turbo; booking-service menyumbang 329 uji.

## Temuan

### Cakupan menemukan tiga cacat, bukan tiga kekurangan uji

Putaran cakupan pertama berhenti di 97,38% cabang, dengan lima cabang tidak tersentuh di `booking-rows.ts`. Pertanyaannya bukan "uji apa yang kurang", tetapi "apakah cabang itu pernah terbukti benar". Tiga di antaranya ternyata cacat:

1. **Pengubah JSON peristiwa mengubah nilai yang tidak dapat disimpan menjadi `null` diam-diam.** Cabangnya tidak pernah tersentuh karena peristiwa domain tidak punya nilai kosong. Jawaban atas "apa yang terjadi bila tersentuh" buruk: jejak audit NFR-10 kehilangan data tanpa suara. Sekarang ia melempar dengan nama bidangnya — dan karena penulisannya di dalam transaksi, keadaan pemesanannya ikut batal. Suntikan S16 menjaga keputusan itu.
2. **Cabang larik di pengubah yang sama tidak pernah dipakai.** Peristiwa domain tidak punya larik. Generalitas yang tidak dapat dibuktikan benar dihapus, dan larik kini ditolak seperti nilai lain yang tidak dikenal.
3. **Satu uji tidak menguji yang disebut namanya.** "Harga yang menunggu persetujuan tanpa rinciannya ditolak" mengosongkan rincian yang disetujui DAN yang diajukan; penolakannya terjadi pada yang disetujui, dan jalur yang disebut nama ujinya tidak pernah tersentuh. Uji itu lulus karena alasan yang salah. Diperbaiki supaya hanya rincian yang diajukan yang kosong.

Cacat nomor 3 adalah cabang `?? undefined` pada pembacaan rincian yang diajukan: ia tidak tersentuh justru karena ujinya berhenti lebih awal. Dua cabang sisanya adalah `checkIn ?? ''` dan `checkOut ?? ''` pada pembacaan tanggal. Keduanya ternyata dapat tercapai — tahun lima digit sah di `DATE` Postgres, tetapi `toISOString` menuliskannya `+010000-...` — jadi nilai bawaan string kosong yang menyamarkannya diganti pemeriksaan terang-terangan yang menyebut kolomnya, dengan uji sendiri. Setelah itu cakupan 100% tanpa menyentuh ambang apa pun.

### Satu sel tabel yang sah tidak selalu berhasil

Uji "setiap sel sah berhasil" gagal pada percobaan pertama untuk `PRICE_CHECKED + acceptPrice`. Tabel menyatakan persetujuan harga bermakna pada PRICE_CHECKED; aturan handler menyatakan ia hanya berhasil dari sub-keadaan `changed`. Contoh PRICE_CHECKED terpendek berada di `verified`.

Ini bukan cacat, tetapi batas yang perlu dinyatakan: **tabel memutuskan apakah sebuah perintah bermakna pada sebuah keadaan; handler memutuskan apakah datanya cocok.** Tabel tidak dipecah menjadi sub-keadaan — itu akan membuat sepuluh keadaan menjadi dua belas demi satu perintah — dan uji sel sah kini memakai contoh yang sesuai untuk perintahnya (`sampleFor`).

### Varians tipe handler diukur terbalik

Versi pertama menulis `Handler<S extends BookingStatus, C>` dengan `BookingIn<S>` sebagai parameternya. Compiler menolak handler yang menerima dua keadaan (`verifyPrice` untuk DRAFT dan PRICE_CHECKED) dipasang pada baris salah satunya. `BookingIn` adalah tipe kondisional, dan varians parameter di dalam tipe kondisional diukur sebagai kovarian — terbalik dari yang benar untuk posisi parameter fungsi. Handler kini diparameterkan langsung dengan tipe pemesanannya.

### Komentar yang mengklaim lebih dari yang ditegakkan

Komentar `PriceBreakdown` menulis "satu-satunya jalan memperolehnya adalah `priceBreakdown`". Antarmukanya struktural, jadi literal `{ total, lineItems }` dari mana pun diterima — klaim itu hanya kesepakatan. Tipe itu kini bermerek, dan `booking.types.test.ts` membuktikan literal ditolak. Kesalahan yang sama ditemukan lebih dulu di uji: satu uji menyusun rincian USD dengan menyebar rincian IDR dan mengganti totalnya.

### `Json?` Prisma memaksa perubahan skema

Rancangan pertama punya dua kolom JSON, satu di antaranya nullable. Kolom `Json?` Prisma tidak menerima `null` biasa; ia menuntut sentinel `Prisma.DbNull` dari klien tergenerate. Akibatnya port `BookingDb` tidak lagi dapat dipenuhi palsuan dan klien sungguhan dengan tipe yang sama — satu-satunya alasan port itu ada. Rincian harga kini satu kolom JSON non-null `price_lines` berisi `{ agreed, quoted }`. Null di dalam JSON tidak punya masalah itu.

### Kesepakatan dengan payment-service membentuk satu aturan domain

payment-service membaca `booking.price_changed.newAmount` sebagai nilai yang boleh ditagih **sejak peristiwa itu terbit**, sebelum pengguna menyetujuinya. Itu aman hanya karena pembayaran tidak mungkin dibuat sebelum HELD, dan HELD menuntut harga yang disetujui dan diverifikasi ulang.

Tetapi ada satu jalur yang merusaknya: harga berubah, lalu price check ulang — sebelum persetujuan — mengembalikan harga semula. Domain akan kembali ke `verified` tanpa `PriceChanged` kedua, dan payment-service tertinggal dengan harga yang sudah ditinggalkan. Karena itu price check ulang saat perubahan menunggu persetujuan ditolak (`price_awaiting_approval`). Uji kesepakatan di `contract-payloads.test.ts` memutar ulang aliran peristiwa lewat aturan payment-service pada lima skenario.

### Keputusan desain yang menyimpang dari step doc

1. **Kunci idempotensi unik per `(user_id, idempotency_key)`, bukan global.** Step doc menulis "idempotencyKey unik". Kunci dikirim klien; dengan keunikan global, dua pengguna yang mengirim kunci sama membuat pengguna kedua menerima pemesanan pengguna pertama — kebocoran data, bukan sekadar tabrakan. Pencarian di port pun wajib menyertakan `userId`.
2. **Indeks digabung.** Step doc meminta indeks pada idempotencyKey, userId, status, dan heldUntil. Yang dibuat: UNIK `(user_id, idempotency_key)` — melayani userId karena kolom terdepan — dan `(status, held_until)` — melayani status dan kueri penyapu Step 17 sekaligus. Tidak ada indeks `idempotency_key` saja, karena tidak ada kueri yang mencari kunci tanpa pemiliknya.
3. **Kolom `amount` dinamai `amount_minor`**, mengikuti `toColumns` di @tbe/money dan Step 18.
4. **Kolom di luar daftar step doc**: kolom khas keadaan (`hold_ref`, `payment_id`, `refund_id`, `failure_reason`, `cancellation`, `review_reason`, `review_from`, `price_check`, `quoted_*`), `price_lines`, `lead_guest_name`, `lead_guest_email`, `version`, dan `sequence` di booking_events. Tanpanya, union diskriminan tidak dapat disusun kembali dari baris.
5. **`supplier_id` berisi kode supplier (`SKY`), bukan UUID.** Kontrak peristiwa membawa kode, dan supplier adalah himpunan tetap.
6. **Kegagalan sebelum pembayaran berakhir di CANCELLED, bukan FAILED.** Step doc mendefinisikan FAILED sebagai "kompensasi sedang atau sudah berjalan", dan jalan keluarnya REFUNDED atau NEEDS_REVIEW. Pemesanan tanpa uang tidak punya apa pun untuk dikembalikan; REFUNDED untuknya adalah catatan palsu.
7. **Tidak ada `index.ts`.** Step 16 tidak punya proses yang berjalan. `config.ts` ada sebagai kontrak env, dengan ujinya sendiri.
8. **Tujuh batasan CHECK dan trigger append-only ditambahkan tangan ke migrasi.** Pertahanan berlapis untuk union diskriminan dan NFR-10 terhadap penulis yang bukan domain. Belum pernah dijalankan terhadap Postgres.

### Ketegangan terbuka dengan Step 25: CONFIRMED final

Step doc ini menyatakan CONFIRMED final dan tanpa transisi keluar, dan itulah yang diimplementasikan dan diuji. Step 25 (pembatalan, FR-27) akan membatalkan pemesanan CONFIRMED dan mengembalikan dana. Keduanya tidak dapat benar sekaligus tanpa perubahan model: Step 25 harus menambahkan sisi keluar dari CONFIRMED — dan uji finalitas dua arah akan gagal, dengan sengaja — atau memodelkan pembatalan pascakonfirmasi sebagai agregat terpisah. Keputusannya bukan milik Step 16; dicatat di sini dan di komentar tabel transisi supaya tidak ditemukan saat uji itu merah.

### Kesalahan sendiri

- Judul uji tabel pertama berbunyi "enam belas transisi"; tabelnya empat belas sel. Ketahuan saat menulis asersinya, sebelum dijalankan.
- Skrip suntikan di scratchpad pernah rusak oleh backslash dalam heredoc shell yang tidak dikutip — `\\n` menjadi baris baru sungguhan di dalam literal string Python. Persis jenis kecelakaan yang menyisipkan byte 0x08 ke verify-money.mjs. Kali ini ia gagal keras sebagai galat sintaks, tidak ada berkas repo yang tersentuh, dan skripnya diperbaiki lewat Edit. Seluruh berkas service juga dipindai untuk byte kendali: bersih.
- `prettier --write src` ikut memformat klien Prisma tergenerate. Berkas itu diabaikan git, jadi tidak ada akibatnya, tetapi perintah format berikutnya sebaiknya tidak menyentuh `src/generated`.

### Catatan tentang repo, bukan tentang step ini

- **`pnpm typecheck` gagal di kontainer baru bila dijalankan sebelum `pnpm build`.** Klien Prisma tergenerate tidak di-commit dan hanya dibuat oleh skrip `build`; tugas `typecheck` turbo bergantung pada `^build` paket lain, bukan `build` dirinya sendiri. auth-service gagal lebih dulu pada baseline, sebelum Step 16 menyentuh apa pun. Urutan verifikasi yang diminta (typecheck sebelum build) hanya hijau di kontainer yang sudah pernah build. Tidak diperbaiki di sini karena menyentuh konfigurasi turbo seluruh repo.
- **`next build` menulis ulang `apps/web/next-env.d.ts`** dengan gaya kutip berbeda setiap kali dijalankan. Dipulihkan sebelum commit; tidak termasuk perubahan step ini.
- **Temuan Step 18 menyebut "`pathToFinal` yang tidak pernah terbukti menjawab tidak di Step 16".** Step 16 belum pernah ada ketika kalimat itu ditulis, dan implementasi ini tidak punya fungsi bernama `pathToFinal` — penelusuran graf hidup di uji, bukan di domain, karena tidak ada kode produksi yang membutuhkannya. Kalimat itu tidak akurat dan dibiarkan apa adanya di step doc 18 sebagai catatan sejarah; koreksinya di sini.
