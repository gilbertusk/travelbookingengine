# booking-service

Siklus hidup pemesanan sebagai state machine eksplisit. Step 16 memodelkan **domainnya saja**: keadaan, transisi, peristiwa, dan penyimpanannya. Belum ada HTTP, Redis, broker, maupun panggilan ke supplier — hold dan price check jatah Step 17, saga jatah Step 19.

Port 4006. Memenuhi fondasi NFR-06, NFR-09, NFR-10, dan G2.

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

Port tidak punya operasi ubah atau hapus peristiwa. Migrasi menambahkan trigger yang menolak `UPDATE`, `DELETE`, dan `TRUNCATE` pada booking_events — mengikat semua penulis, bukan hanya kode kita. **Belum pernah dijalankan terhadap Postgres.**

## Skema

| Tabel            | Isi                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------ |
| `bookings`       | Keadaan sekarang. Kolom khas keadaan nullable; batasan CHECK per keadaan di migrasi. |
| `booking_events` | Jejak audit, hanya bertambah. `sequence` = versi pemesanan sesudah transisi.         |

Migrasi [`20260927000000_init`](prisma/migrations/20260927000000_init/migration.sql) dihasilkan offline dengan `prisma migrate diff --from-empty --to-schema`. Bagian di bawah garis penanda ditulis tangan: tujuh batasan CHECK dan trigger append-only.

Rincian harga disimpan di **satu** kolom JSON non-null `price_lines` (`{ agreed, quoted }`), bukan dua kolom yang salah satunya nullable: kolom `Json?` Prisma tidak menerima `null` biasa, dan menuntut sentinel `Prisma.DbNull` membuat port tidak lagi dapat dipenuhi palsuan dan klien sungguhan dengan tipe yang sama.

## Bukti suntikan

Aturan sejak Step 03: setiap penjagaan diuji terhadap pelanggaran yang sengaja disuntikkan. Seluruhnya dipulihkan, dan pemulihannya diperiksa dengan membandingkan berkas terhadap cadangan.

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

329 uji, tanpa Docker dan tanpa jaringan. Cakupan: **100% pernyataan, cabang, fungsi, dan baris**. Ambang domain 95%, ambang service 85%.

Angka 100% dicapai dengan memperbaiki desain, bukan menambah uji semata — tiga cabang yang tidak tersentuh ternyata cacat. Lihat bagian Temuan di [docs/plan/step-16-booking-domain.md](../../docs/plan/step-16-booking-domain.md).

`prisma-client.ts` (pembuatan koneksi) dan `config.ts` dikecualikan dari cakupan. Repository Prisma **tidak** dikecualikan: ia diuji terhadap palsuan yang meniru transaksi.

## Menjalankan

Step 16 belum punya proses yang berjalan — tidak ada `index.ts`, tidak ada HTTP. Yang dapat dijalankan adalah migrasinya:

```bash
cp apps/booking-service/.env.example apps/booking-service/.env
pnpm infra:up
pnpm --filter @tbe/booking-service db:deploy
```

## Perintah verifikasi yang BELUM dijalankan

Docker Desktop mati sejak Step 05. Tidak ada Postgres, jadi perintah di bawah **belum pernah dijalankan** dan tidak ada klaim yang dibuat tentang hasilnya.

| Perintah / pemeriksaan                                              | Yang diharapkan                                                                                                                                                                                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm --filter @tbe/booking-service db:deploy`                      | Migrasi `20260927000000_init` berlaku bersih pada basis data kosong, **termasuk bagian yang ditulis tangan**: tujuh CHECK dan fungsi plpgsql beserta dua trigger. Bagian itu belum pernah diurai Postgres.                     |
| `pnpm --filter @tbe/booking-service db:migrate` setelah deploy      | Prisma tidak melaporkan drift atas CHECK dan trigger yang tidak dikenalnya. Belum dipastikan.                                                                                                                                  |
| `\d bookings` di psql                                               | `check_in` dan `check_out` bertipe `date`; `held_until`, `created_at`, `updated_at` bertipe `timestamp(3) with time zone`. Yang terbukti sekarang hanya teks migrasinya.                                                       |
| Pulang-pergi tanggal lewat `@prisma/adapter-pg`                     | `2026-11-10` ditulis dan dibaca kembali sebagai `2026-11-10` dengan proses Node ber-`TZ=Asia/Jakarta` dan `TZ=America/Los_Angeles`. Yang terbukti sekarang hanya fungsi pemetaan kita, bukan perilaku adapter terhadap `DATE`. |
| `UPDATE booking_events SET payload = '{}'` dan `DELETE`, `TRUNCATE` | Ketiganya ditolak dengan `booking_events hanya bertambah`.                                                                                                                                                                     |
| Uji atomisitas terhadap Postgres                                    | Kegagalan penulisan peristiwa membatalkan baris pemesanan. Terbukti terhadap palsuan; BELUM terhadap Postgres.                                                                                                                 |
| Sepuluh `create` serentak dengan kunci idempotensi sama             | Satu baris, sembilan `duplicate`. Mengandalkan Prisma 7 + adapter-pg melaporkan pelanggaran UNIK sebagai `P2002`; itu belum pernah diamati langsung.                                                                           |
| Dua `save` serentak dari versi yang sama                            | Satu `saved`, satu `stale` — penulis kedua menunggu kunci baris lalu melihat versi yang sudah naik (READ COMMITTED).                                                                                                           |
| INSERT yang melanggar tiap CHECK                                    | Ditolak: CONFIRMED tanpa `supplier_ref`, DRAFT dengan `hold_ref`, HELD tanpa `held_until`, `check_out <= check_in`.                                                                                                            |
