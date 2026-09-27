# booking-service

Siklus hidup pemesanan sebagai state machine eksplisit (Step 16), ditambah price check dan hold dua lapis (Step 17). Belum ada broker: saga, outbox, dan penerbitan peristiwa Kafka jatah Step 19.

Port 4006. Memenuhi FR-13 sampai FR-16, FR-18, US-02, US-04, NFR-06, NFR-09, NFR-10, dan G2.

## Yang paling penting di sini

**Transisi tidak sah tidak dapat terjadi diam-diam, dan data tidak dapat melekat pada keadaan yang salah.**

Yang pertama ditegakkan tabel transisi dan `Result`; yang kedua ditegakkan compiler. Keduanya dibuktikan dengan menyuntikkan pelanggaran dan memastikan pelanggaran itu ditolak — lihat [Bukti suntikan](#bukti-suntikan).

## Sepuluh keadaan

```
                 ┌──────────── cancel ─────────────┐
                 │                                  ▼
DRAFT ─verifyPrice→ PRICE_CHECKED ─hold→ HELD ─recordPayment→ PAID ─confirm→ CONFIRMED ■
  │               ↺ verifyPrice      │    │                    │
  │               ↺ acceptPrice      │    └─expireHold→ EXPIRED ■
  └─cancel→ CANCELLED ■ ←─cancel─────┘                         ├─fail→ FAILED ─recordRefund→ REFUNDED ■
                                                               │        │
                                                               └────────┴─requireReview→ NEEDS_REVIEW ■
```

■ = keadaan final. Lima: `CONFIRMED`, `REFUNDED`, `CANCELLED`, `EXPIRED`, `NEEDS_REVIEW`.

### Union diskriminan dengan larangan eksplisit

[`src/domain/booking.ts`](src/domain/booking.ts). Setiap keadaan membawa bidang miliknya, **dan menyatakan bidang milik keadaan lain sebagai `?: never`**:

```ts
type State<S, Own> = BookingBase & { status: S } & Pick<StateFields, Own> &
  Partial<Readonly<Record<Exclude<StateField, Own>, never>>>
```

Union biasa belum cukup. TypeScript hanya memeriksa bidang berlebih pada literal objek segar; `{ ...confirmed, status: 'DRAFT' }` lolos union biasa dengan `supplierRef` yang bukan milik DRAFT. Dengan larangan `never`, baris itu galat compiler.

Harga yang dibayar: membaca `booking.supplierRef` pada union tanpa mempersempit sekarang **diizinkan** — hasilnya `string | undefined`. Yang tetap dijaga adalah pemakaiannya: nilai itu tidak dapat masuk ke tempat yang menuntut `string`. Dibuktikan di [`booking.types.test.ts`](src/domain/booking.types.test.ts), yang berisi sepuluh `@ts-expect-error`. Bila penjagaan dilepas, direktifnya menjadi "tidak terpakai" dan `pnpm typecheck` gagal.

### Tabel transisi sebagai data

[`src/domain/transitions.ts`](src/domain/transitions.ts) dan `COMMAND_TARGETS` di [`commands.ts`](src/domain/commands.ts). Baris adalah keadaan asal, kolom adalah perintah yang sah; tujuannya ditentukan perintah. Empat belas sel sah dari seratus.

Tabelnya diperiksa compiler per sel: handler `confirm` membaca `paymentId`, jadi memasangnya pada baris HELD — yang tidak punya `paymentId` — adalah galat tipe. Dan handler wajib mengembalikan keadaan yang dinyatakan `COMMAND_TARGETS`.

Ketiadaan yang disengaja:

| Tidak ada                   | Alasannya                                                                                                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PAID -cancel->`            | Setelah uang diterima, pembatalan adalah kompensasi, bukan perubahan keadaan. Jalannya FAILED → REFUNDED. PAID → CANCELLED berarti pemesanan final dengan uang yang tertahan. |
| `HELD -fail->`              | Belum ada uang. Kegagalan pembayaran pada HELD adalah `cancel` beralasan `payment_failed`. FAILED hanya untuk keadaan yang punya uang untuk dikembalikan.                     |
| `FAILED -confirm->`         | Konfirmasi yang terlambat setelah kompensasi dimulai adalah status yang tidak pasti → `requireReview` (US-05).                                                                |
| Satu pun dari keadaan final | NFR-06. `CONFIRMED` termasuk — lihat catatan Step 25 di bawah.                                                                                                                |

### `Result`, bukan diabaikan

`applyCommand` mengembalikan `Result<BookingChange, BookingError>`. Dua jenis galat, keduanya 409:

- `InvalidTransitionError` — perintah tidak bermakna pada keadaan ini (86 sel).
- `BookingRuleError` — perintahnya bermakna, datanya melanggar aturan: `price_awaiting_approval`, `price_not_reverified`, `no_price_change`, `hold_window_invalid`, `hold_not_expired`, `amount_mismatch`, `blank_field`.

### NFR-06 dibuktikan atas graf, dari dua arah

[`transitions.test.ts`](src/domain/transitions.test.ts):

1. Setiap keadaan final tidak punya transisi keluar, **dan** setiap keadaan tanpa transisi keluar dinyatakan final. Satu arah saja melewatkan keadaan tengah yang buntu.
2. Dari setiap keadaan tidak final, penelusuran graf menjangkau keadaan final. "Tidak buntu" belum cukup — dua keadaan yang saling menunjuk tanpa jalan keluar tidak buntu, tetapi pemesanannya menggantung.
3. Setiap keadaan dapat dicapai dari DRAFT.

## Harga yang disetujui (G2)

`booking.price` adalah harga yang **terakhir disetujui pengguna** — satu-satunya nilai yang boleh ditagih. `PRICE_CHECKED` membawa sub-keadaan:

| `priceCheck.kind` | Artinya                                        | Boleh hold?                       |
| ----------------- | ---------------------------------------------- | --------------------------------- |
| `verified`        | Harga supplier sama dengan harga disetujui     | Ya                                |
| `changed`         | Harga berbeda, menunggu persetujuan            | Tidak (`price_awaiting_approval`) |
| `accepted`        | Harga baru disetujui, BELUM diverifikasi ulang | Tidak (`price_not_reverified`)    |

`accepted` yang membuat tuntutan Step 17 — "persetujuan menghasilkan price check ulang" — ditegakkan domain, bukan diingat pemanggil.

### Kesepakatan dengan payment-service

payment-service (Step 18) menetapkan nilai yang boleh ditagih dari peristiwa terakhir di antara `booking.created.amount` dan `booking.price_changed.newAmount`. [`contract-payloads.test.ts`](src/application/contract-payloads.test.ts) memutar ulang aliran peristiwa domain lewat aturan yang sama dan memastikan, pada lima skenario perubahan harga, bahwa **nilai yang diyakini payment-service sama dengan harga disetujui setiap kali pemesanan mencapai HELD**.

Aturan `price_awaiting_approval` pada price check ulang ada karena kesepakatan ini. Tanpanya, harga yang berubah lalu kembali ke semula sebelum disetujui tidak menerbitkan `PriceChanged` kedua, dan payment-service tertinggal dengan harga yang sudah tidak berlaku.

## Peristiwa domain ≠ peristiwa Kafka

Dua belas peristiwa domain, satu per transisi ([`events.ts`](src/domain/events.ts)). Enam di antaranya punya pasangan Kafka; pemetaannya di [`application/contract-payloads.ts`](src/application/contract-payloads.ts) dan diuji dengan **mengurai hasilnya memakai skema Zod dari `@tbe/event-contracts`** — skema yang sama dengan yang dipakai consumer payment-service.

Belum ada yang menerbitkannya. Selama itu, `POST /internal/payments` di payment-service tetap menolak dengan `amount_unknown` pada sistem yang berjalan. Penerbitan lewat outbox adalah jatah Step 19.

## Tanggal menginap: DATE, dan diuji di zona yang salah

`checkIn` dan `checkOut` adalah `LocalDate` — string `YYYY-MM-DD` bermerek — di domain, dan kolom `DATE` di basis data. Bukan `Date`, bukan `TIMESTAMP`.

Pemetaan kolomnya ([`booking-rows.ts`](src/infrastructure/booking-rows.ts)) menulis tengah malam UTC dan membaca lewat `toISOString`. Cacat klasiknya — `new Date(y, m, d)` dan `getDate()` — **tidak terlihat sama sekali di mesin ber-UTC**, dan kontainer hampir selalu UTC. Karena itu [`vitest.config.ts`](vitest.config.ts) menjalankan uji di `America/Los_Angeles`, dan ada uji penjaga yang gagal bila zona itu hilang. Suntikan S13b membuktikan penjaga itu perlu: dengan zona UTC, bug `new Date(y, m, d)` lolos seluruh uji lainnya.

## Satu transaksi untuk bookings dan booking_events

[`prisma-booking-repository.ts`](src/infrastructure/prisma-booking-repository.ts). Setiap penulisan adalah satu `$transaction` yang memuat baris pemesanan **dan** baris peristiwanya. Port-nya ([`application/ports.ts`](src/application/ports.ts)) menerima keduanya sebagai satu `BookingChange` — tidak ada operasi yang menyimpan salah satunya saja.

### Repository sungguhan terhadap basis data palsuan yang punya rollback

Repository bergantung pada [`BookingDb`](src/infrastructure/booking-db.ts), tipe struktural kecil, bukan `PrismaClient`. Dua akibatnya:

- **Jalan tulis hanya lewat transaksi.** Klien akar di tipe itu hanya dapat membaca; `create`, `updateMany`, dan tabel booking_events hanya ada pada klien transaksi.
- **Palsuan yang jujur.** [`testing/memory-db.ts`](src/testing/memory-db.ts) meniru rollback, batasan UNIK (`P2002`), kunci asing (`P2003`), dan penulis yang diserialkan. Palsuan tandingannya, `autocommitBookingDb`, tidak punya rollback — dan uji atomisitas yang sama **harus gagal** padanya. Kegagalan itu sendiri adalah uji yang tetap ada di suite.

Bahwa `PrismaClient` tergenerate benar-benar memenuhi `BookingDb` **dibuktikan compiler** di [`prisma-client.ts`](src/infrastructure/prisma-client.ts), bukan diasumsikan. Suntikan S17 memastikan pembuktian itu tidak hampa.

### Kunci versi dan nomor urut peristiwa

Setiap transisi menaikkan `version`. Repository menyimpan dengan `updateMany ... WHERE version = versi_sebelumnya`; nol baris berarti `stale`, dan tidak ada yang ditulis. Versi yang sama menjadi `sequence` di booking_events, dengan UNIK `(booking_id, sequence)`.

Dua lapis itu bukan pengulangan. Suntikan S14 mengganti kunci versi dengan "baca versi terbaru lalu tulis" — lost update klasik — dan yang menangkapnya adalah UNIK `(booking_id, sequence)`: transaksi kedua batal dan tidak ada yang tertimpa.

### Idempotensi per pengguna

UNIK `(user_id, idempotency_key)`, bukan `idempotency_key` global. Kunci dikirim klien; dengan keunikan global, dua pengguna yang mengirim kunci sama membuat pengguna kedua menerima pemesanan pengguna pertama. Tidak ada pemeriksaan "sudah ada?" sebelum menyisipkan — pelanggaran UNIK yang memutuskan, lalu pemenangnya diambil.

### Append only

Port tidak punya operasi ubah atau hapus peristiwa. Migrasi menambahkan trigger yang menolak `UPDATE`, `DELETE`, dan `TRUNCATE` pada booking_events — mengikat semua penulis, bukan hanya kode kita. **Terbukti terhadap Postgres 16 sungguhan** sejak Step 17 (lihat [Uji integrasi](#uji-integrasi)).

## Price check (FR-13, FR-14, US-02)

`POST /bookings/price-check` membuat pemesanan bila kunci idempotensinya belum dikenal, lalu **selalu** memverifikasi harga langsung ke supplier. Permintaan ulang dengan kunci yang sama tidak membuat pemesanan kedua; ia memverifikasi ulang pemesanan yang sama.

**Tidak ada cache di jalur ini, dan tidak ada port untuknya.** Uji membuktikan setiap price check adalah satu panggilan ke supplier, termasuk yang diulang untuk pemesanan yang sama dalam detik yang sama. Suntikan H1 — menyimpan hasil per pemesanan — menggagalkan uji itu.

### Harga supplier bukan harga jual

Supplier mengembalikan harga SUPPLIER; pengguna menyetujui harga JUAL (FR-05), setelah markup dan pajak dari pricing-service. Membandingkan keduanya langsung akan melaporkan "harga berubah" pada setiap pemesanan. Karena itu setiap harga supplier dihitung ulang lewat pricing-service — dengan kota pemesanan sebagai cakupan aturan markup — sebelum dibandingkan ([`domain/sell-price.ts`](src/domain/sell-price.ts)). Total dari pricing-service tidak dipercaya begitu saja: baris-barisnya harus menjumlah tepat ke total itu.

| Hasil                             | Keadaan pemesanan                 | HTTP                                  |
| --------------------------------- | --------------------------------- | ------------------------------------- |
| Harga sama                        | `PRICE_CHECKED` / `verified`      | 200, `priceCheck.outcome = unchanged` |
| Harga berbeda                     | `PRICE_CHECKED` / `changed`       | 200, harga lama, baru, dan selisihnya |
| Rate plan habis / tidak ada       | `CANCELLED` (`supplier_rejected`) | 409 `RATE_UNAVAILABLE`                |
| Supplier / pricing belum menjawab | tidak berubah                     | 503 — pengguna boleh mencoba lagi     |
| Kunci sama, pemesanan lain        | tidak berubah                     | 409 `IDEMPOTENCY_KEY_REUSED`          |

Harga berubah dijawab **200**, bukan 409: glosarium PRD menyatakan Rate Change kondisi normal. `POST /bookings/price-check/accept` menyetujui harga baru lalu menjalankan price check **ulang** dalam permintaan yang sama; domain menolak hold sampai verifikasi ulang itu berhasil.

## Hold dua lapis (FR-15, US-04)

`POST /bookings/hold` — [`application/place-hold.ts`](src/application/place-hold.ts). Urutannya adalah keputusannya, dan setiap langkah punya kompensasi:

1. **Periksa domain tanpa efek.** Perintah hold dicoba terhadap domain dengan nilai sementara; kalau ditolak, tidak ada yang disentuh.
2. **Lokal (Redis, skrip Lua).** Pemeriksaan dan pengambilan kursi dalam satu skrip atomik. Permintaan yang pasti tidak kebagian tidak pernah sampai ke supplier.
3. **Supplier.** Gagal → kursi lokal dilepas.
4. **Harga saat hold.** Total dari supplier dihitung ulang menjadi harga jual dan dibandingkan dengan harga yang disetujui. Berbeda → kursi dilepas, 409 `PRICE_CHANGED`.
5. **Simpan.** Batas waktu = yang lebih awal antara lokal dan supplier; kunci waktu lokal dimajukan ke sana.

### Kursi sebagai anggota set, bukan angka yang dikurangi

[`infrastructure/redis-hold-store.ts`](src/infrastructure/redis-hold-store.ts). Kursi yang terpakai adalah anggota `SET`. Angka yang dikurangi harus dikembalikan tepat sekali, dan "tepat sekali" di antara dua jalur pelepasan adalah persis masalah yang ingin dihindari; dengan set, pelepasan kedua adalah `SREM` yang tidak menghapus apa-apa.

Kapasitas slot diambil dari `unitsLeft` hasil pencarian dan **ditetapkan sekali**: permintaan berikutnya tidak dapat menaikkannya. Angka itu datang dari klien dan menua, jadi lapis lokal mencegah perebutan, bukan menggantikan inventaris — lapis supplier tetap otoritas terakhir.

### Hold di supplier tidak dapat dilepaskan

Tidak ada operasi pelepasan hold di mana pun — tidak di `SupplierGateway`, supplier-service, maupun kelima supplier simulasi. Hold supplier kedaluwarsa sendiri. Setiap kompensasi setelah langkah 3 meninggalkan hold supplier yang habis sendiri, paling lambat bersamaan dengan hold lokal karena `heldUntil` yang lebih awal.

## Pelepasan otomatis (FR-16)

Dua jalur, satu use case ([`application/expire-hold.ts`](src/application/expire-hold.ts)):

- **Keyspace notification** — cepat, tidak dapat diandalkan. Redis tidak mengantrikan notifikasi untuk pelanggan yang sedang terputus.
- **Penyapu berkala** ([`application/sweep-holds.ts`](src/application/sweep-holds.ts)) — jaring pengaman, dari dua sumber: pemesanan HELD yang lewat di basis data, dan kursi di Redis yang kunci waktunya hilang (proses mati di antara hold lokal dan penyimpanan — kursi yang tidak pernah dikenal basis data).

Keduanya aman berjalan bersamaan: perpindahan ke EXPIRED dijaga kunci versi, dan pelepasan kursi idempoten. Basis data dulu, Redis sesudahnya — kebalikannya membuka jendela di mana kursi sudah kembali sementara pemesanan masih HELD.

Notifikasi yang tiba sebelum `heldUntil` menurut jam kita — jam Redis dan jam mesin tidak persis sama — **tidak** melepas apa pun. Kedaluwarsa lebih awal membuat pengguna yang sedang membayar kehilangan kamarnya; penyapu akan kembali.

Service memeriksa `notify-keyspace-events` saat startup dan mencatat peringatan bila tidak memuat `Ex`.

## Skema

| Tabel            | Isi                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------ |
| `bookings`       | Keadaan sekarang. Kolom khas keadaan nullable; batasan CHECK per keadaan di migrasi. |
| `booking_events` | Jejak audit, hanya bertambah. `sequence` = versi pemesanan sesudah transisi.         |

Migrasi [`20260927000000_init`](prisma/migrations/20260927000000_init/migration.sql) dihasilkan offline dengan `prisma migrate diff --from-empty --to-schema`. Bagian di bawah garis penanda ditulis tangan: tujuh batasan CHECK dan trigger append-only. Migrasi [`20260928000000_add_city`](prisma/migrations/20260928000000_add_city/migration.sql) (Step 17) menambahkan kota properti — cakupan aturan markup. Keduanya diterapkan ke Postgres 16 sungguhan, dan `prisma migrate diff` terhadap basis data hasilnya kosong: Prisma tidak menganggap CHECK dan trigger tulisan tangan sebagai drift.

Rincian harga disimpan di **satu** kolom JSON non-null `price_lines` (`{ agreed, quoted }`), bukan dua kolom yang salah satunya nullable: kolom `Json?` Prisma tidak menerima `null` biasa, dan menuntut sentinel `Prisma.DbNull` membuat port tidak lagi dapat dipenuhi palsuan dan klien sungguhan dengan tipe yang sama.

## Bukti suntikan

Aturan sejak Step 03: setiap penjagaan diuji terhadap pelanggaran yang sengaja disuntikkan. Seluruhnya dipulihkan, dan pemulihannya diperiksa dengan membandingkan berkas terhadap cadangan.

### Step 17

| #   | Pelanggaran yang disuntikkan                                               | Diperiksa terhadap     | Hasil        | Uji gagal |
| --- | -------------------------------------------------------------------------- | ---------------------- | ------------ | --------- |
| H1  | Price check dilayani dari cache                                            | unit                   | GAGAL (baik) | 19        |
| H2  | Harga berubah tidak menghentikan alur (harga supplier diabaikan)           | unit                   | GAGAL (baik) | 14        |
| H3  | Hold memakai harga supplier saat hold, bukan harga yang disetujui          | unit                   | GAGAL (baik) | 2         |
| H4  | Skrip Lua diganti baca-lalu-tulis dari klien                               | **Redis sungguhan**    | GAGAL (baik) | 4         |
| H5  | Palsuan hold store atomik diganti pola periksa-lalu-tulis                  | unit                   | GAGAL (baik) | 2         |
| H6  | Pendengar keyspace tidak meneruskan kedaluwarsa                            | **Redis sungguhan**    | GAGAL (baik) | 3         |
| H7  | Penyapu tidak mencari kursi yatim di Redis                                 | unit                   | GAGAL (baik) | 1         |
| H8  | Kueri penyapu memakai `lt` alih-alih `lte`                                 | **Postgres sungguhan** | GAGAL (baik) | 1         |
| H9  | Kedaluwarsa melepas kursi walau belum waktunya menurut domain              | unit                   | GAGAL (baik) | 1         |
| H10 | Hold yang sedang diproses permintaan lain dilanjutkan ke supplier          | unit                   | GAGAL (baik) | 2         |
| H11 | Kunci idempotensi yang sama untuk pemesanan lain dijawab pemesanan pertama | unit                   | GAGAL (baik) | 2         |
| H12 | Batasan UNIK `(user_id, idempotency_key)` dihapus dari migrasi             | **Postgres sungguhan** | GAGAL (baik) | 1         |
| H13 | Batas waktu hold memakai yang LEBIH AKHIR antara lokal dan supplier        | unit                   | GAGAL (baik) | 13        |
| H14 | bookings dan booking_events ditulis di transaksi terpisah                  | **Postgres sungguhan** | GAGAL (baik) | 1         |

H1 ditangkap langsung oleh uji "setiap price check adalah satu panggilan ke supplier, termasuk yang diulang" — bukan hanya oleh efek sampingnya di uji lain.

### Step 16

| #    | Pelanggaran yang disuntikkan                                                  | Diperiksa | Hasil        | Yang gagal |
| ---- | ----------------------------------------------------------------------------- | --------- | ------------ | ---------- |
| S1   | Transisi tidak sah dikembalikan `ok` tanpa perubahan (diabaikan diam-diam)    | vitest    | GAGAL (baik) | 88 uji     |
| S2   | Keadaan final CONFIRMED diberi transisi keluar `cancel`                       | vitest    | GAGAL (baik) | 5 uji      |
| S3   | Keadaan tidak final FAILED dibuat buntu                                       | vitest    | GAGAL (baik) | 24 uji     |
| S4   | `checkIn` menjadi `@db.Timestamptz(3)`, migrasi dihasilkan ulang              | vitest    | GAGAL (baik) | 2 uji      |
| S4b  | `checkOut` menjadi `@db.Timestamp(3)`, migrasi dihasilkan ulang               | vitest    | GAGAL (baik) | 3 uji      |
| S5   | booking_events ditulis di transaksi terpisah dari bookings (pembuatan)        | vitest    | GAGAL (baik) | 2 uji      |
| S5b  | booking_events ditulis di transaksi terpisah dari bookings (transisi)         | vitest    | GAGAL (baik) | 2 uji      |
| S6   | Berkas suntikan: DRAFT dengan `supplierRef`                                   | tsc       | GAGAL (baik) | 1 galat    |
| S6b  | Larangan `?: never` dilepas dari union                                        | tsc       | GAGAL (baik) | 17 galat   |
| S7   | Berkas suntikan: domain mengimpor infrastructure                              | eslint    | GAGAL (baik) | 1 galat    |
| S8   | Price check ulang diizinkan saat perubahan menunggu persetujuan               | vitest    | GAGAL (baik) | 1 uji      |
| S9   | Hold diizinkan setelah persetujuan tanpa price check ulang                    | vitest    | GAGAL (baik) | 1 uji      |
| S10  | Pembayaran bernilai berbeda dari harga disetujui diterima                     | vitest    | GAGAL (baik) | 2 uji      |
| S11  | Kolom DATE ditulis sebagai tengah malam zona mesin                            | vitest    | GAGAL (baik) | 2 uji      |
| S12  | Kolom DATE dibaca dengan `getDate()`                                          | vitest    | GAGAL (baik) | 19 uji     |
| S13  | Zona uji non-UTC dihapus                                                      | vitest    | GAGAL (baik) | 1 uji      |
| S13b | S11 dan S13 bersamaan                                                         | vitest    | GAGAL (baik) | 1 uji      |
| S14  | Kunci versi diganti "baca versi terbaru lalu tulis"                           | vitest    | GAGAL (baik) | 1 uji      |
| S15  | Tabrakan kunci idempotensi dilempar alih-alih mengembalikan pemesanan pertama | vitest    | GAGAL (baik) | 2 uji      |
| S16  | Nilai peristiwa yang tidak dapat disimpan diubah diam-diam menjadi teks       | vitest    | GAGAL (baik) | 3 uji      |
| S17  | Port `BookingDb` mengklaim kolom yang tidak ada di `PrismaClient`             | tsc       | GAGAL (baik) | 5 galat    |

Keluaran S6 dan S7:

```
src/domain/__injected-draft-ref.ts(5,14): error TS2322: Type '{ ...; supplierRef: string; }' is not assignable to type 'Booking'.

apps/booking-service/src/domain/__injected-boundary.ts
  1:23  error  domain tidak boleh mengimpor dari infrastructure  boundaries/element-types
```

S13b adalah satu-satunya yang ditangkap **hanya** oleh uji penjaga: tanpa zona non-UTC, bug zona itu sendiri lolos. Itulah alasan uji penjaga ada.

## Uji

```bash
pnpm --filter @tbe/booking-service test
```

449 uji unit, tanpa Redis, Postgres, maupun jaringan. Cakupan: **99,67% pernyataan, 99,43% cabang, 100% fungsi, 100% baris**. Ambang domain 95%, ambang service 85%. Suite unit juga dijalankan dengan urutan acak (`--sequence.shuffle`) dan tetap hijau.

Dua pernyataan yang tidak tersentuh, keduanya penjaga cacat perangkaian, bukan keadaan sah: lemparan di `price-check.ts` bila `isCheckable` dan tabel transisi tidak lagi sepakat, dan lemparan di `booking-routes.ts` bila middleware identitas tidak terpasang pada rute.

Dikecualikan dari cakupan unit: `index.ts`, `telemetry.ts`, `config.ts`, `prisma-client.ts`, `system.ts`, dan adapter Redis (`redis-hold-store.ts`, `keyspace-expiry.ts`) — yang terakhir diuji terhadap Redis sungguhan, di bawah.

### Uji integrasi

```bash
export INTEGRATION_DATABASE_URL=postgresql://tbe@localhost:5440/booking_it
export INTEGRATION_REDIS_URL=redis://localhost:6390/5
pnpm test:integration
```

39 uji terhadap **Redis 7.0.15 dan PostgreSQL 16.13 sungguhan**, di [`tests/integration`](tests/integration). Basis data uji dibangun ulang dari migrasi setiap kali — trigger append-only menolak pembersihan tabel, dan memang harus. Uji GAGAL keras bila salah satu env tidak ada; tidak dilewati diam-diam.

Docker masih mati, tetapi kontainer pengembangan Step 17 ternyata sudah membawa `redis-server` dan PostgreSQL 16 terpasang langsung. CONVENTIONS.md meminta Testcontainers; tanpa Docker, infrastrukturnya diberikan lewat env.

Dijalankan di zona `Asia/Jakarta` dan `America/Los_Angeles`, masing-masing tiga kali dengan urutan acak. Yang dibuktikan:

| Klaim                                                                         | Sebelumnya (Step 16)       |
| ----------------------------------------------------------------------------- | -------------------------- |
| Skrip Lua: 100 pengambilan serentak untuk kapasitas 10 → tepat 10             | —                          |
| Logika yang sama tanpa Lua, Redis yang sama → lebih dari 10                   | —                          |
| 100 hold serentak ujung ke ujung → tepat 10 HELD di Postgres                  | —                          |
| Keyspace notification → EXPIRED di Postgres, kursi kembali di Redis           | —                          |
| Penyapu dan keyspace serentak → satu `HoldExpired`, satu pelepasan            | —                          |
| Kegagalan tulisan peristiwa membatalkan baris pemesanan                       | hanya terhadap palsuan     |
| 10 `create` serentak, kunci sama → 1 baris, 9 `duplicate` (P2002 nyata)       | hanya terhadap palsuan     |
| 2 `save` serentak dari versi sama → satu `saved`, satu `stale`                | hanya terhadap palsuan     |
| `check_in`/`check_out` tersimpan `2026-11-10` lewat adapter-pg                | hanya fungsi pemetaan kita |
| Trigger menolak UPDATE, DELETE, TRUNCATE pada booking_events                  | belum dijalankan           |
| Enam dari tujuh CHECK menolak pelanggarannya (`version_positive` tidak diuji) | belum dijalankan           |
| Setiap keadaan pulang-pergi melewati Postgres tanpa perubahan                 | hanya terhadap palsuan     |

## Menjalankan

```bash
cp apps/booking-service/.env.example apps/booking-service/.env
pnpm infra:up
pnpm --filter @tbe/booking-service db:deploy
pnpm --filter @tbe/booking-service build && pnpm --filter @tbe/booking-service start
```

## Antarmuka

Seluruhnya lewat api-gateway, yang mewajibkan autentikasi untuk `/bookings` dan meneruskan identitas sebagai `x-tbe-user-id`. Tanpa header itu — atau bukan UUID — dijawab 401, sebelum isi permintaan diperiksa. Pemesanan milik pengguna lain dijawab 404, sama dengan pemesanan yang tidak ada.

| Rute                                | Guna                                                       |
| ----------------------------------- | ---------------------------------------------------------- |
| `POST /bookings/price-check`        | Buat bila belum ada (idempoten), lalu price check langsung |
| `POST /bookings/price-check/accept` | Setujui harga baru, lalu price check ulang                 |
| `POST /bookings/hold`               | Hold lokal lalu supplier                                   |
| `GET /bookings/:id`                 | Keadaan pemesanan milik sendiri                            |

## Perintah verifikasi yang BELUM dijalankan

| Pemeriksaan                                                               | Yang diharapkan                                                                                                                                                                      |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Alur lewat supplier-service dan pricing-service yang berjalan             | Price check dan hold terhadap mock-supplier sungguhan. Yang terbukti sekarang: penerjemahan jawaban HTTP (unit) dan use case terhadap supplier/pricing palsuan (unit dan integrasi). |
| `pnpm --filter @tbe/booking-service start` dengan infra lengkap           | Startup, pemeriksaan `notify-keyspace-events`, penyapu terjadwal, dan penutupan berurutan. `index.ts` belum pernah dijalankan.                                                       |
| Lewat api-gateway                                                         | `x-tbe-user-id` diteruskan dan header kiriman klien dibuang. Diuji di api-gateway sendiri (Step 07), belum ujung ke ujung dengan service ini.                                        |
| Konsumsi `booking.created` / `booking.price_changed` oleh payment-service | Belum ada yang menerbitkannya — outbox Step 19. Sampai itu, `POST /internal/payments` tetap menolak `amount_unknown`.                                                                |
