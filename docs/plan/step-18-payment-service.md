# Step 18 — payment-service

**Fase 3** · Milestone 4 · Estimasi 6 jam · Prasyarat: Step 17 · Q1 sudah dijawab: sandbox Midtrans

## Tujuan

Menangani uang masuk dan keluar dengan jaminan idempotency. Webhook pembayaran datang berulang sebagai perilaku normal, bukan anomali, dan sistem harus tahan terhadap itu.

## Prompt

```
Buat apps/payment-service.

Baca terlebih dahulu PRD FR-19 sampai FR-23, NFR-07, dan CONVENTIONS.md bagian 9.

Tulis test lebih dulu.

Keputusan Q1 sudah diambil: memakai sandbox Midtrans.

Seluruh komunikasi ke Midtrans berada di belakang port PaymentGateway. Port ini
bukan formalitas — ia adalah titik tempat chaos test Step 28 menyuntikkan
kegagalan, karena sandbox tidak dapat diperintah gagal sesuai kehendak.
Jangan memanggil SDK Midtrans dari mana pun selain adapter-nya.

Ketentuan khusus Midtrans:
- Verifikasi tanda tangan notifikasi memakai SHA-512 atas
  order_id + status_code + gross_amount + server_key. Lakukan dengan
  perbandingan waktu tetap, bukan perbandingan string biasa
- Server key dan client key dari env, divalidasi saat startup
- Pemetaan status Midtrans ke status internal dinyatakan eksplisit sebagai
  tabel, bukan rangkaian percabangan: capture dan settlement menjadi SUCCEEDED,
  pending tetap PENDING, deny, cancel, expire, dan failure menjadi FAILED
- transaction_id dari Midtrans dipakai sebagai pengenal peristiwa untuk
  idempotency
- Sandbox mengirim notifikasi ganda sebagai perilaku normal. Ini bukan anomali
  yang perlu dicegah, melainkan yang harus ditangani

1. Domain
   - Payment dengan keadaan: PENDING, SUCCEEDED, FAILED, REFUNDED,
     PARTIALLY_REFUNDED
   - Refund sebagai entitas tersendiri, satu pembayaran bisa punya beberapa refund
   - Seluruh nilai memakai packages/money
   - Total refund tidak boleh melebihi nilai pembayaran. Tegakkan di domain,
     bukan hanya di database

2. Idempotency webhook (NFR-07)
   Ini inti step ini:
   - Setiap webhook masuk disimpan dengan pengenal peristiwa dari penyedia
     sebagai kunci unik
   - Webhook yang sudah pernah diproses mengembalikan hasil sebelumnya tanpa
     efek samping apa pun
   - Ditegakkan lewat batasan unik database, bukan pemeriksaan di aplikasi
   - Webhook yang datang tidak berurutan ditangani benar: notifikasi sukses
     yang tiba setelah notifikasi gagal tidak boleh membalikkan keadaan final
   - Tanda tangan webhook diverifikasi sebelum diproses. Tanda tangan tidak sah
     ditolak dan dicatat sebagai peringatan keamanan

3. Alur pembayaran
   - Buat maksud pembayaran untuk satu pemesanan, dengan nilai yang diambil
     dari harga yang disetujui pengguna
   - Terima notifikasi penyedia
   - Terbitkan payment.succeeded atau payment.failed ke Kafka
   - Jangan memanggil booking-service secara langsung. Komunikasi lewat peristiwa

4. Refund
   - Consumer RabbitMQ untuk perintah payment.refund
   - Refund bersifat idempoten terhadap pengenal permintaan refund
   - Refund gagal masuk retry berjenjang, dan setelah habis masuk dead letter
     dengan peringatan tingkat error, karena ini berarti uang pengguna tertahan
   - Terbitkan payment.refunded setelah berhasil

5. Skema Prisma
   - payments: id, bookingId, amount (integer), currency, status, gatewayRef,
     idempotencyKey unik, createdAt, updatedAt
   - refunds: id, paymentId, amount, currency, reason, status, gatewayRef,
     requestId unik, createdAt
   - webhook_events: id, providerEventId unik, payload, processedAt, outcome
   - Tidak ada kolom float atau double

6. Keamanan
   - Kredensial penyedia dari env, divalidasi saat startup
   - Payload webhook yang dicatat sudah diredaksi dari data sensitif
   - Endpoint webhook tidak memerlukan autentikasi pengguna tetapi memverifikasi
     tanda tangan, dan punya pembatasan laju tersendiri

Test yang wajib:
- Webhook sama diproses dua kali hanya menghasilkan satu efek
- Sepuluh webhook identik serentak hanya menghasilkan satu efek
- Webhook tidak berurutan tidak membalikkan keadaan final
- Tanda tangan tidak sah ditolak
- Refund melebihi nilai pembayaran ditolak di domain
- Refund idempoten terhadap pengenal permintaan

Commit: feat: add payment service with idempotent webhook handling
```

## Definisi Selesai

- [x] Idempotency webhook ditegakkan lewat batasan unik database — **terbukti terhadap palsuan yang meniru batasan UNIK; BELUM terhadap Postgres sungguhan.** Migrasi memuat `CREATE UNIQUE INDEX webhook_events_provider_event_id_key`, dan adapter memakai `ON CONFLICT DO NOTHING` tanpa `SELECT` mendahuluinya. Yang terbukti adalah bahwa kode bergantung pada batasan itu, bukan bahwa Postgres menegakkannya
- [x] Sepuluh webhook identik serentak menghasilkan tepat satu efek — terbukti terhadap palsuan; ketidakhampaan ujinya terbukti terhadap palsuan tandingan yang memakai pola "periksa dulu baru tulis" dan menghasilkan sepuluh efek
- [x] Webhook tidak berurutan tidak merusak keadaan final — terbukti di domain (tabel transisi 5×3, seluruh sel diuji) dan di lapisan aplikasi
- [x] Tanda tangan diverifikasi dan yang tidak sah dicatat sebagai peringatan keamanan — terbukti lewat logger sungguhan, bukan palsuan logger; tingkat `warn` dengan penanda `security: true`
- [ ] Perbandingan tanda tangan berwaktu tetap — **hanya terbukti secara STRUKTURAL**, lewat uji yang membaca kodenya sendiri dan menolak perbandingan kesetaraan apa pun di luar perbandingan panjang buffer. Tidak ada uji perilaku yang dapat membedakan `timingSafeEqual` dari `===`, dan uji pengukuran waktu sengaja ditolak karena rapuh. Dicatat sebagai kotak yang TIDAK dicentang
- [x] Total refund tidak dapat melebihi nilai pembayaran — ditegakkan di domain, sebelum penyedia dihubungi. Refund yang masih menunggu ikut menghabiskan kuota; yang gagal membebaskannya
- [x] Refund gagal permanen mencatat galat tingkat error, bukan sekadar peringatan — terbukti lewat pembungkus consumer `@tbe/messaging` yang sesungguhnya, dengan header percobaan yang sudah habis
- [x] Refund idempoten terhadap pengenal permintaan — terbukti berurutan dan serentak (sepuluh perintah, satu panggilan penyedia)
- [x] Tidak ada kredensial di kode atau test — server key hanya dari env, divalidasi Zod saat startup, dan tidak pernah melewati lapisan aplikasi maupun domain. Nilai di `signature.test.ts` adalah kunci contoh yang dibuat untuk uji, ditandai demikian di berkasnya
- [x] Cakupan test ≥ 85% — **98,25% pernyataan, 97,39% cabang, 100% fungsi, 98,07% baris.** Enam baris tak tersentuh disebutkan satu per satu di README
- [ ] Migrasi berlaku pada basis data sungguhan — **BELUM.** Migrasi dihasilkan offline dan dibaca dengan mata; Docker mati sejak Step 05
- [ ] Notifikasi sungguhan dari sandbox Midtrans terverifikasi — **BELUM.** Yang terbukti adalah algoritma tanda tangannya terhadap jawaban yang diketahui, bukan bahwa bahannya sama dengan yang dipakai Midtrans
- [ ] Consumer peristiwa pemesanan benar-benar menerima peristiwanya — **BELUM.** Tidak ada Kafka, dan booking-service belum ada (lihat Temuan). Pada sistem yang berjalan, `POST /internal/payments` akan selalu menolak `amount_unknown` sampai ini terbukti
- [x] Commit terbuat

## Catatan

Test "sepuluh webhook identik serentak" berbeda dari "webhook diproses dua kali berurutan". Yang pertama menguji balapan di database, yang kedua hanya menguji percabangan. Pastikan yang pertama ada — itu yang membuktikan idempotency sungguhan.

## Bukti

Lima belas suntikan pelanggaran, masing-masing dijalankan lalu dipulihkan. Skrip yang menjalankannya ada di luar repo (scratchpad sesi); tabelnya di bawah, dan tabel yang sama ada di README service.

| #   | Pelanggaran yang disuntikkan                                     | Berkas                                  | Hasil        | Uji gagal |
| --- | ---------------------------------------------------------------- | --------------------------------------- | ------------ | --------- |
| S1  | Verifikasi tanda tangan dilewati                                 | `application/handle-notification.ts`    | GAGAL (baik) | 3         |
| S2  | Perbandingan tanda tangan memakai `===` biasa                    | `domain/signature.ts`                   | GAGAL (baik) | 2         |
| S3  | Klaim buku besar memakai "periksa dulu baru tulis"               | `testing/stores.ts`                     | GAGAL (baik) | 1         |
| S4  | Klaim belum selesai dianggap duplikat yang sudah selesai         | `application/handle-notification.ts`    | GAGAL (baik) | 2         |
| S5  | Batas total refund dilonggarkan (refund menunggu tidak dihitung) | `domain/refund.ts`                      | GAGAL (baik) | 2         |
| S6  | Webhook tidak berurutan membalikkan keadaan final                | `domain/payment.ts`                     | GAGAL (baik) | 5         |
| S7  | Peristiwa diterbitkan sebelum keadaan tersimpan                  | `application/handle-notification.ts`    | GAGAL (baik) | 1         |
| S8  | Idempotensi refund dilewati (tabrakan tetap dilanjutkan)         | `application/refund-payment.ts`         | GAGAL (baik) | 1         |
| S9  | `capture` + `challenge` dianggap berhasil                        | `domain/provider-status.ts`             | GAGAL (baik) | 2         |
| S10 | `gross_amount` dihitung dengan aritmetika pecahan biner          | `domain/gross-amount.ts`                | GAGAL (baik) | 1         |
| S11 | Perbandingan harga yang disetujui dilewati                       | `application/create-payment-intent.ts`  | GAGAL (baik) | 5         |
| S12 | `booking.price_changed` memakai harga lama                       | `messaging/booking-events.ts`           | GAGAL (baik) | 4         |
| S13 | Refund gagal permanen masuk dead letter sebagai peringatan       | `packages/messaging/rabbit/consumer.ts` | GAGAL (baik) | 2         |
| S14 | Payload webhook dicatat tanpa redaksi                            | `application/handle-notification.ts`    | GAGAL (baik) | 1         |
| S15 | Pemesanan tanpa harga tercatat memakai nilai permintaan          | `application/create-payment-intent.ts`  | GAGAL (baik) | 3         |

Batas heksagonal, disuntik dengan berkas `domain/__injected-boundary.ts` yang mengimpor `../infrastructure/system.js`:

```
1:29  error  domain tidak boleh mengimpor dari infrastructure  boundaries/element-types
```

Seluruh sepuluh perintah verifikasi hijau: `lint`, `typecheck`, `test`, `build`, `verify:money`, `verify:boundaries`, `verify:tokens`, `verify:contrast`, `verify:catalog`, `verify:loadtest`.

## Temuan

### Step 16 dan 17 belum ada, dan itu ketahuan di awal

Prasyarat step ini adalah Step 17, tetapi repo berada di Step 15: tidak ada `apps/booking-service` di ref mana pun, dan commit "feat: add hold mechanism and price check" tidak pernah ada. Lima berkas yang biasanya dipakai sebagai acuan — `expire-hold.ts`, `domain/booking.ts` beserta `amountDue()`, `prisma-booking-repository.test.ts`, `testing/fakes.ts` dengan `memoryAvailability`/`racyAvailability`, dan berkas konfigurasi booking-service — seluruhnya tidak ada.

Keputusannya: mengerjakan Step 18 berdiri sendiri, karena step doc-nya justru **melarang** memanggil booking-service langsung, dan kontrak peristiwa pembayaran sudah lengkap di `packages/event-contracts` sejak Step 05. Pola konfigurasi dan palsuan diturunkan dari `supplier-service` dan `pricing-service`, bukan dari booking-service.

Konsekuensi yang harus ditanggung Step 19: `payable_amounts` diisi dari `booking.created` dan `booking.price_changed`, dan **belum ada yang menerbitkan keduanya.** Pada sistem yang berjalan, `POST /internal/payments` akan selalu menolak dengan `amount_unknown` sampai booking-service ada.

### Uji yang gagal menemukan bug urutan yang nyata

"Perintah kedua dengan pengenal yang sama tidak mengembalikan dana dua kali" gagal pada implementasi pertama. Sebabnya: `requestRefund` memeriksa **keadaan pembayaran** sebelum memeriksa **pengenal permintaan**. Refund yang berhasil mengembalikan seluruh nilai membuat pembayaran menjadi `REFUNDED`, yang bukan keadaan yang menerima refund — jadi perintah yang dikirim ulang RabbitMQ untuk refund yang sudah tuntas dijawab "tidak dapat direfund", terlihat seperti kegagalan, lalu dicoba ulang sampai masuk dead letter untuk pekerjaan yang sudah selesai.

Urutannya dibalik: "sudah pernah diminta" adalah fakta tentang pengenal itu, bukan tentang keadaan pembayaran sekarang.

### Tabel notifikasi saja tidak dapat membuktikan finalitas

Uji dua arah "tepat keadaan final yang tidak punya transisi keluar" gagal saat pertama ditulis, dan kegagalannya benar. Dari tabel notifikasi penyedia saja, `SUCCEEDED` dan `PARTIALLY_REFUNDED` **juga** tidak punya transisi keluar — transisi keluar keduanya datang dari refund, dan refund bukan webhook.

Menyimpulkan finalitas dari satu tabel akan menyatakan pembayaran berhasil sebagai keadaan final padahal dana masih dapat dikembalikan. Buktinya dipindah ke `refund.test.ts`, satu-satunya tempat kedua tabel terlihat sekaligus, dan uji di `payment.test.ts` dipersempit menjadi klaim satu arah yang memang dapat dibuktikan dari sana. Cara yang sama menemukan `pathToFinal` yang tidak pernah terbukti menjawab "tidak" di Step 16 — pola pemeriksaan dua arah ini terbukti berulang kali lebih tajam daripada uji satu arah.

### Satu suntikan yang tidak tertangkap, dan kenapa itu bukan uji yang hampa

Percobaan pertama S11 mengganti nilai yang ditagih dari `payable.amount` menjadi `input.amount`. **Seluruh uji tetap lulus.** Sebabnya bukan uji yang lemah: perbandingan kesetaraan yang berjalan lebih dulu sudah menjamin keduanya sama di titik itu, jadi substitusinya adalah penulisan ulang yang setara — bukan bug.

Yang diungkapnya tetap penting: seluruh jaminan G2 di service ini bertumpu pada satu perbandingan, dan tidak ada uji perilaku yang dapat membedakan kedua penulisannya. Tanggapannya bukan menambah uji, melainkan memperkuat perbandingannya: perbandingan dua bidang dengan tangan (`currency !== ... || amountMinor !== ...`) digantikan `equals` dari `@tbe/money` dengan penjaga mata uang, supaya ia ikut berubah bersama tipenya alih-alih diam-diam berhenti lengkap saat `Money` bertambah bidang. Suntikan S11 lalu diarahkan ke perbandingan itu sendiri, dan tertangkap lima uji.

### Logger sungguhan menangkap asumsi yang salah

Uji tingkat log ditulis dengan `level === 40` mengikuti angka bawaan pino. Ketiganya gagal: `shared-kernel` memasang `formatters.level` yang menulis **label**, bukan angka. Palsuan logger buatan sendiri akan lulus terhadap angka yang tidak pernah ada di keluaran mana pun.

### Cakupan mengungkap dua potong kode yang tidak dapat dibuktikan benar

- `publish()` menerima `Payment` — lima keadaan — padahal notifikasi penyedia hanya dapat menghasilkan dua. Cabang untuk tiga keadaan sisanya tidak dapat diuji karena tidak dapat terjadi. Diperbaiki dengan tipe `AppliedPayment`, bukan dengan menambah uji.
- `WEBHOOK_OUTCOMES` diekspor tetapi tidak pernah dieksekusi. Pertanyaannya apakah daftar itu perlu ada; jawabannya perlu — sebagai bahan uji yang membandingkan enum skema Prisma dengan union TypeScript dari dua arah. Drift antara keduanya lolos kompilasi, lolos seluruh uji yang memakai palsuan, lalu gagal sebagai galat Postgres pada notifikasi pertama yang memakainya.
- `isRetryable()` di `refund-payment.ts` juga tidak pernah dipakai. Itu memang kode mati; dihapus.

### Penyimpangan sengaja dari step doc

1. **`capture` + `fraud_status: challenge` dipetakan ke PENDING, bukan SUCCEEDED.** Step doc menyebut "capture dan settlement menjadi SUCCEEDED" tanpa menyebut fraud. `challenge` berarti dana tertahan dan belum tentu pernah masuk; memperlakukannya sebagai sukses akan mengonfirmasi kamar ke supplier atas pembayaran yang masih mungkin dibatalkan.
2. **Kolom `amount` dinamai `amountMinor`.** Step doc menulis `amount (integer)`. Nama `amountMinor` mengikuti `toColumns` di `@tbe/money` dan daftar akhiran bukan-uang di `verify-money.mjs`, dan konsisten dengan `fixedAmountMinor` di pricing-service.
3. **Tiga status Midtrans tambahan dipetakan** (`authorize`, `refund`, `partial_refund`). Status yang tidak dipetakan menjadi `unsupported`, yang berarti notifikasinya ditolak dan penyedia mengirimnya ulang tanpa henti.
4. **Tabel `payable_amounts` ditambahkan**, di luar empat tabel yang disebut step doc. Tanpanya, nilai yang ditagih datang dari pihak yang meminta pembayaran, dan G2 menjadi hiasan.

### Yang tidak dikerjakan dan alasannya

**Melanjutkan pembayaran yang terputus tidak didukung.** Tautan pembayaran (`redirect_url`) tidak disimpan, jadi permintaan berulang atas pembayaran yang sudah `PENDING` menagih ulang ke penyedia dengan `order_id` yang sama untuk memperoleh tautan yang sama. Menyimpan tautannya membutuhkan kolom di luar yang disebut step doc, dan idempotensi di sisi penyedia lewat `order_id` sudah cukup untuk FR-18. Kalau Step 21 membutuhkan penyajian ulang tautan tanpa memanggil penyedia, kolomnya ditambahkan di sana.

**Klaim webhook yang menggantung tidak punya pembersih.** Baris yang diklaim tetapi tidak pernah ditutup — proses mati di tengah — akan menolak setiap notifikasi berikutnya dengan 409 selamanya. Yang menyelamatkannya sekarang hanyalah pengiriman ulang penyedia, yang juga akan ditolak. Ini cacat nyata yang belum ditangani; tempatnya di rekonsiliasi Step 28, dan disebutkan di sini supaya tidak hilang.
