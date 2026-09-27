# Step 17 — Hold dan price check

**Fase 3** · Milestone 4 · Estimasi 5 jam · Prasyarat: Step 16

## Tujuan

Dua mekanisme yang mencegah dua kelas masalah berbeda: hold mencegah penjualan melebihi ketersediaan, price check mencegah pengguna dibebani harga yang tidak disetujuinya. Keduanya memenuhi FR-13 sampai FR-16 dan G2.

## Prompt

```
Implementasikan mekanisme hold dan price check di apps/booking-service.

Baca terlebih dahulu PRD FR-13 sampai FR-16, US-02, US-04, dan Bab 2.2 masalah 2.

Tulis test lebih dulu.

1. Price check (FR-13, FR-14, US-02)
   - Sebelum meminta pembayaran, verifikasi harga langsung ke supplier lewat
     supplier-service. TIDAK BOLEH dilayani dari cache, tanpa pengecualian
   - Hasilnya berupa union diskriminan:
     unchanged  -> lanjut ke hold
     changed    -> hentikan alur, kembalikan harga lama dan baru beserta selisih,
                   terbitkan booking.price_changed, tunggu persetujuan eksplisit
     unavailable-> hentikan alur dengan pesan yang jelas
   - Persetujuan harga baru menghasilkan permintaan price check ulang.
     Harga bisa berubah lagi, dan sistem harus tahan terhadap itu
   - Simpan harga yang disetujui pengguna. Pembebanan pembayaran WAJIB memakai
     nilai ini, bukan nilai lain mana pun

2. Hold (FR-15, FR-16)
   Dua lapis, keduanya diperlukan:

   Lapis lokal — Redis:
   - Kunci per rate plan per rentang tanggal
   - Skrip Lua untuk pemeriksaan dan pengurangan secara atomik. Ini yang
     menjamin US-04: pada M permintaan serentak untuk N ketersediaan,
     tepat N yang berhasil
   - TTL sesuai durasi hold
   - Jangan memakai pola baca lalu tulis. Harus satu operasi atomik

   Lapis supplier:
   - Panggil operasi hold supplier lewat supplier-service
   - Simpan token hold dan waktu kedaluwarsanya
   - Waktu kedaluwarsa yang dipakai sistem adalah yang lebih awal antara
     kedaluwarsa lokal dan kedaluwarsa supplier

3. Pelepasan hold otomatis
   - Manfaatkan keyspace notification Redis untuk kunci yang kedaluwarsa
   - Saat hold lokal kedaluwarsa: lepaskan hold di supplier, pindahkan
     pemesanan ke EXPIRED, terbitkan peristiwa
   - Sediakan juga pekerjaan penyapu berkala sebagai jaring pengaman, karena
     keyspace notification tidak menjamin pengiriman. Penyapu harus idempoten
   - Dua jalur ini tidak boleh saling merusak bila berjalan bersamaan

4. Idempotency (FR-18)
   - Permintaan pemesanan membawa idempotency key dari klien
   - Kunci yang sama mengembalikan pemesanan yang sama, tidak membuat yang baru
   - Ditegakkan lewat batasan unik di database, bukan hanya pemeriksaan di aplikasi.
     Pemeriksaan di aplikasi punya celah balapan

5. Endpoint
   - POST /bookings/price-check
   - POST /bookings/price-check/accept
   - POST /bookings/hold
   - GET  /bookings/:id

Test yang wajib:
- Price check tidak pernah menyentuh cache — dibuktikan dengan test
- Harga berubah menghentikan alur dan menerbitkan peristiwa yang benar
- Pembebanan selalu memakai harga yang terakhir disetujui
- Seratus permintaan hold serentak untuk ketersediaan sepuluh: tepat sepuluh berhasil
- Hold kedaluwarsa melepaskan hold supplier dan memindahkan keadaan ke EXPIRED
- Penyapu berkala idempoten dan aman dijalankan bersamaan dengan jalur keyspace
- Idempotency key yang sama tidak menghasilkan pemesanan kedua, dibuktikan
  dengan dua permintaan serentak

Commit: feat: add hold mechanism and price check
```

## Definisi Selesai

- [x] Price check selalu langsung ke supplier, tidak pernah dari cache — booking-service tidak punya port cache sama sekali; uji membuktikan setiap price check adalah satu panggilan ke supplier, termasuk yang diulang dalam detik yang sama (suntikan H1). Jalur supplier-service `priceCheck` dibaca: langsung ke adapter lewat pemutus sirkuit, tanpa cache
- [x] Alur berhenti dan meminta persetujuan ketika harga berubah — `PRICE_CHECKED`/`changed`, hold ditolak domain sampai disetujui DAN diverifikasi ulang; persetujuan menjalankan price check ulang (suntikan H2)
- [x] Pembebanan memakai harga yang disetujui, dibuktikan dengan test — di sisi booking-service: hold membandingkan harga jual saat hold dengan harga yang disetujui (suntikan H3), dan domain menolak pembayaran bernilai lain (Step 16). Pembebanan sungguhan terjadi di payment-service, yang membaca nilainya dari `booking.price_changed` — dan peristiwa itu BELUM diterbitkan sampai outbox Step 19
- [x] Pengurangan ketersediaan atomik lewat skrip Lua — terbukti terhadap Redis 7.0.15 sungguhan, dengan pembanding tanpa Lua pada Redis yang sama yang menjual lebih dari kapasitas (suntikan H4)
- [x] Seratus permintaan serentak untuk ketersediaan sepuluh menghasilkan tepat sepuluh — terhadap palsuan (dengan palsuan tandingan, suntikan H5), terhadap Redis sungguhan, dan ujung ke ujung dengan Postgres sungguhan: tepat 10 HELD, 90 `sold_out`, supplier dipanggil 10 kali
- [x] Hold terlepas otomatis saat kedaluwarsa, baik lewat keyspace maupun penyapu — hold LOKAL, ke EXPIRED, terbukti ujung ke ujung terhadap Redis dan Postgres sungguhan, termasuk keduanya serentak (suntikan H6, H7). Hold di SUPPLIER tidak dilepaskan: tidak ada operasinya di mana pun dalam rantai supplier — lihat Temuan. Peristiwa `HoldExpired` tercatat di booking_events; penerbitannya ke Kafka menunggu outbox Step 19
- [x] Idempotency ditegakkan lewat batasan unik database — UNIK `(user_id, idempotency_key)`; sepuluh pembuatan serentak terhadap Postgres sungguhan menghasilkan satu pemesanan dan sembilan duplikat (suntikan H12). Kunci yang sama untuk pemesanan berbeda ditolak (suntikan H11)
- [x] Cakupan test ≥ 85% — 99,67% pernyataan, 99,43% cabang, 100% fungsi, 100% baris
- [x] Commit terbuat — `feat: add hold mechanism and price check`, commit yang memuat dokumen ini

## Catatan

Jaring pengaman berupa penyapu berkala sering dianggap mubazir karena keyspace notification "biasanya jalan". Redis tidak menjamin pengiriman notifikasi kepada klien yang sedang terputus. Tanpa penyapu, hold yatim akan menahan inventaris selamanya — dan itu baru ketahuan saat demo.

## Bukti

Empat belas suntikan pelanggaran Step 17, masing-masing diterapkan, diperiksa, lalu dipulihkan; pemulihannya diperiksa dengan membandingkan `src/`, `tests/`, dan `prisma/` terhadap cadangan. Lima di antaranya diperiksa terhadap **Redis dan Postgres sungguhan**, bukan palsuan. Skrip suntikan ada di luar repo (scratchpad sesi).

| #   | Pelanggaran yang disuntikkan                                               | Berkas                                        | Diperiksa terhadap | Hasil        | Uji gagal |
| --- | -------------------------------------------------------------------------- | --------------------------------------------- | ------------------ | ------------ | --------- |
| H1  | Price check dilayani dari cache                                            | `application/live-quote.ts`                   | unit               | GAGAL (baik) | 19        |
| H2  | Harga berubah tidak menghentikan alur                                      | `application/price-check.ts`                  | unit               | GAGAL (baik) | 14        |
| H3  | Hold memakai harga supplier saat hold, bukan harga yang disetujui          | `application/place-hold.ts`                   | unit               | GAGAL (baik) | 2         |
| H4  | Skrip Lua diganti baca-lalu-tulis dari klien                               | `infrastructure/redis-hold-store.ts`          | Redis sungguhan    | GAGAL (baik) | 4         |
| H5  | Palsuan hold store atomik diganti pola periksa-lalu-tulis                  | `testing/fakes.ts`                            | unit               | GAGAL (baik) | 2         |
| H6  | Pendengar keyspace tidak meneruskan kedaluwarsa                            | `infrastructure/keyspace-expiry.ts`           | Redis sungguhan    | GAGAL (baik) | 3         |
| H7  | Penyapu tidak mencari kursi yatim                                          | `application/sweep-holds.ts`                  | unit               | GAGAL (baik) | 1         |
| H8  | Kueri penyapu memakai `lt` alih-alih `lte`                                 | port, repository, palsuan                     | Postgres sungguhan | GAGAL (baik) | 1         |
| H9  | Kedaluwarsa melepas kursi walau belum waktunya                             | `application/expire-hold.ts`                  | unit               | GAGAL (baik) | 1         |
| H10 | Hold yang sedang diproses dilanjutkan ke supplier                          | `application/place-hold.ts`                   | unit               | GAGAL (baik) | 2         |
| H11 | Kunci idempotensi yang sama untuk pemesanan lain dijawab pemesanan pertama | `application/price-check.ts`                  | unit               | GAGAL (baik) | 2         |
| H12 | Batasan UNIK `(user_id, idempotency_key)` dihapus dari migrasi             | `prisma/migrations/*_init/migration.sql`      | Postgres sungguhan | GAGAL (baik) | 1         |
| H13 | Batas waktu hold memakai yang lebih akhir                                  | `domain/hold-window.ts`                       | unit               | GAGAL (baik) | 13        |
| H14 | bookings dan booking_events di transaksi terpisah                          | `infrastructure/prisma-booking-repository.ts` | Postgres sungguhan | GAGAL (baik) | 1         |

449 uji unit dan 39 uji integrasi. Uji integrasi dijalankan di zona `Asia/Jakarta` dan `America/Los_Angeles`, masing-masing tiga kali dengan urutan acak; suite unit tiga kali dengan urutan acak. Seluruh sepuluh perintah verifikasi hijau, ditambah `pnpm test:integration`.

## Temuan

### Redis dan Postgres ternyata tersedia — tanpa Docker

Docker masih mati, tetapi kontainer pengembangan ini sudah membawa `redis-server` 7.0.15 dan PostgreSQL 16.13 terpasang langsung. Keduanya dijalankan di scratchpad pada port 6390 dan 5440. Step ini adalah yang pertama sejak Step 05 yang membuktikan klaim terhadap infrastruktur sungguhan, dan sebagian besar daftar "BELUM" Step 16 ikut tertutup:

- migrasi Step 16 berlaku bersih, termasuk ketujuh CHECK dan trigger yang ditulis tangan;
- `prisma migrate diff` terhadap basis data hasil migrasi kosong — Prisma tidak menganggap CHECK dan trigger sebagai drift;
- Prisma 7 + adapter-pg melaporkan pelanggaran UNIK sebagai `P2002`, asumsi yang sebelumnya belum pernah diamati;
- kolom DATE bertahan pulang-pergi lewat adapter-pg di zona di depan dan di belakang UTC;
- transaksi, kunci versi, dan trigger append-only berperilaku seperti yang ditiru palsuan.

CONVENTIONS.md meminta Testcontainers untuk uji integrasi. Tanpa Docker, infrastrukturnya diberikan lewat `INTEGRATION_DATABASE_URL` dan `INTEGRATION_REDIS_URL`, dan uji gagal keras bila salah satunya tidak ada.

### Tidak ada operasi pelepasan hold di supplier — di mana pun

Step doc meminta "saat hold lokal kedaluwarsa: lepaskan hold di supplier". Operasi itu tidak ada: tidak di `SupplierGateway` (@tbe/supplier-adapters), tidak di supplier-service, tidak di satu pun dari lima supplier simulasi di mock-supplier. Hold supplier kedaluwarsa sendiri pada `expiresAt`-nya.

Port `SupplierQuotes` sengaja TIDAK diberi operasi pelepasan palsu yang tidak melakukan apa-apa. Yang dilakukan: batas waktu yang dipakai adalah yang lebih awal di antara keduanya, jadi hold supplier tidak pernah hidup lebih lama dari yang diyakini sistem kecuali bila supplier yang lebih awal — dan kompensasi setelah hold supplier (harga berubah saat hold, pemesanan dibatalkan di tengah) meninggalkan hold supplier yang habis sendiri. Menambahkan pelepasan sungguhan menyentuh lima adapter, lima supplier simulasi, dan supplier-service; itu bukan perubahan Step 17, dan dicatat di sini supaya tidak hilang.

### Harga supplier bukan harga yang disetujui pengguna

Price check supplier mengembalikan harga SUPPLIER; pengguna melihat dan menyetujui harga JUAL setelah markup dan pajak (FR-05). Membandingkan keduanya langsung akan melaporkan "harga berubah" pada setiap pemesanan. Setiap harga supplier kini dihitung ulang lewat pricing-service sebelum dibandingkan — saat price check DAN saat hold.

Akibatnya pada model Step 16: pricing-service mencakup aturan markup per kota, jadi pemesanan harus menyimpan kota. `city` ditambahkan ke domain dan ke skema lewat migrasi kedua, `20260928000000_add_city`.

### Step 16 mempertahankan rincian harga yang ditampilkan — e-voucher akan kehilangan pajak

Uji HTTP menemukan bahwa setelah price check yang harganya sama, rincian harga tetap satu baris "Harga yang ditampilkan". Aturan Step 16 sengaja mempertahankan rincian yang disetujui bila totalnya sama. Tidak salah untuk nilai yang ditagih, tetapi harga yang ditampilkan hanya membawa total, jadi e-voucher (FR-24) akan terbit tanpa baris pajak. `verifyPrice` kini mengadopsi rincian terverifikasi bila totalnya sama; nilai yang boleh ditagih tidak berubah.

### Dua jalur pelepasan dengan dua definisi "kedaluwarsa"

Aturan domain menyatakan hold kedaluwarsa pada `now >= heldUntil`. Kueri penyapu versi pertama memakai `held_until < now`. Tepat di batas waktu, jalur keyspace melepas tetapi penyapu tidak. Ditemukan uji "penyapu idempoten", diperbaiki menjadi `lte`, dan dijaga suntikan H8 terhadap Postgres sungguhan.

### Cakupan menemukan tiga potong kode yang tidak dapat terbukti benar

1. **Penguraian uang kedua kali.** Jawaban supplier-service dan pricing-service sudah divalidasi `moneySchema`, yang mata uangnya enum. Adapter mengurainya lagi dengan `fromJson` dan menangani kegagalannya — kegagalan yang mustahil. Dihapus.
2. **`refused` pada price check.** `isCheckable` hanya meloloskan keadaan tempat `verifyPrice` dan `cancel` sah; penolakan domain di sana berarti keduanya tidak lagi sepakat. Itu cacat program, bukan jawaban untuk pengguna — kini dilempar.
3. **`vanished` pada `persist`.** Pemesanan yang hilang di tengah transisi dijadikan varian hasil yang sah, memaksa setiap pemanggil menangani hal mustahil (kunci asing booking_events mencegah penghapusan). Kini galat tak terduga.

Dua lemparan tersisa sebagai satu-satunya pernyataan yang tidak tersentuh, keduanya penjaga cacat perangkaian.

### Pengacakan urutan uji menemukan dua ketergantungan tersembunyi

Uji integrasi berbagi satu basis data, dan dua uji saya bergantung pada data uji lain:

- Kueri penyapu diuji dengan batas 10. Bila `hold-flow.test.ts` berjalan lebih dulu, sepuluh pemesanan HELD-nya — yang lebih lama — mengisi batas itu. Gagal hanya pada urutan tertentu; akarnya urutan berkas, bukan "flaky".
- Uji trigger UPDATE/DELETE bergantung pada baris booking_events yang dibuat uji lain. Trigger per baris tidak menolak apa pun pada tabel kosong, karena tidak ada baris yang tersentuh. Ditemukan `--sequence.shuffle`.

Keduanya kini membuat datanya sendiri. Suite unit dan integrasi dijalankan berulang dengan urutan acak.

### Turbo membuang env uji integrasi

`pnpm test:integration` dari akar repo gagal walau `INTEGRATION_*` sudah di-export: turbo 2 berjalan dalam mode env ketat dan tidak meneruskan variabel yang tidak dideklarasikan. Desain "gagal keras, jangan dilewati" yang menangkapnya — uji yang melewati dirinya bila env kosong akan hijau tanpa menguji apa pun. Ditambahkan `passThroughEnv: ["INTEGRATION_*"]` pada tugas `test:integration` di turbo.json.

### Keputusan desain

1. **Price check yang membuat pemesanan.** Tidak ada endpoint pembuatan terpisah: `POST /bookings/price-check` membuat pemesanan bila kuncinya belum dikenal. Pemesanan tanpa price check tidak punya kegunaan, dan satu endpoint berarti satu titik idempotensi.
2. **Kunci sama, isi berbeda → 409 `IDEMPOTENCY_KEY_REUSED`.** Mengembalikan pemesanan pertama diam-diam membuat pengguna mengira sudah memesan kamar lain.
3. **Hold yang sedang diproses → 409 `HOLD_IN_PROGRESS`,** bukan melanjutkan. Melanjutkan berarti dua hold supplier untuk satu pemesanan. Harganya: proses yang mati di antara hold lokal dan penyimpanan membuat pengulangan ditolak sampai kunci waktu lokal habis dan penyapu yatim melepas kursinya — paling lama durasi hold ditambah satu selang penyapu.
4. **Kapasitas slot dari `unitsLeft` klien, ditetapkan sekali.** Hasil price check supplier tidak membawa ketersediaan, dan membaca cache search-service berarti kopling antar service. Angka dari klien tidak dipercaya untuk menaikkan kapasitas; lapis supplier tetap otoritas.
5. **Slot per rentang tanggal persis.** Rentang yang tumpang tindih (10–12 dan 11–13 November) memakai slot berbeda; lapis supplier yang menjaganya. Menghitung per malam butuh ketersediaan per malam, dan pencarian hanya memberi satu angka.
6. **Harga berubah dijawab 200.** Rate Change kondisi normal menurut glosarium PRD; 409 hanya untuk rate plan yang sudah tidak tersedia.
7. **Kegagalan supplier yang sementara tidak membatalkan pemesanan.** Hanya `SOLD_OUT` dan 404 yang dianggap penolakan; timeout, pemutus terbuka, 5xx, dan 409 lain menjadi 503 "coba lagi".

### Kesalahan sendiri

- Dua kali meninggalkan ekspor sisa yang tak berguna di akhir berkas (`export type { Result }`, `export { ConflictError }`) — ketahuan saat membaca ulang, sebelum lint.
- Dua kali memakai `as never` di uji untuk melompati union yang dibangun Step 16 — sekali menyusun pemesanan CANCELLED tangan, sekali skema palsu. Keduanya diganti transisi domain sungguhan dan skema Zod sungguhan.
- Uji HTTP untuk dua hold serentak mengasumsikan kedua permintaan benar-benar tumpang tindih. Yang kedua tiba setelah yang pertama selesai dan dijawab sebagai pengulangan yang sah. Balapan sesungguhnya diuji di lapisan aplikasi; uji HTTP kini deterministik.

### Yang tidak dikerjakan

- **Peristiwa Kafka.** `booking.price_changed` dan pembatalan karena hold kedaluwarsa tercatat di booking_events, tetapi tidak diterbitkan — outbox jatah Step 19. payment-service tetap menolak `amount_unknown` sampai itu.
- **Alur lewat supplier-service dan pricing-service yang berjalan.** Penerjemahan jawaban HTTP diuji unit, dan use case diuji terhadap palsuan keduanya; alur terhadap mock-supplier sungguhan belum dijalankan.
- **`index.ts` belum pernah dijalankan.** Seluruh bagiannya diuji terpisah — aplikasi HTTP lewat factory yang sama, penyapu terkelola, pendengar keyspace — tetapi proses utuhnya belum.
