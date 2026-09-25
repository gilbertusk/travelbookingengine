# payment-service

Menangani uang masuk dan keluar dengan jaminan idempotensi. Memenuhi FR-19 sampai FR-23, NFR-07, NFR-08, dan G2.

Port 4007. Penyedia: sandbox Midtrans (keputusan Q1).

## Yang paling penting di sini

**Webhook yang datang berulang adalah perilaku normal, bukan anomali yang perlu dicegah.**

Sandbox Midtrans mengirim notifikasi yang sama beberapa kali, dan tidak menjamin urutannya. Seluruh bentuk service ini mengikuti kenyataan itu.

## Idempotensi ditegakkan basis data, bukan aplikasi

Satu baris SQL yang menentukan segalanya:

```sql
INSERT INTO webhook_events (id, provider_event_id, payload)
VALUES (...) ON CONFLICT (provider_event_id) DO NOTHING
```

Tidak ada `SELECT` sebelum `INSERT`, dan **ketiadaan itu adalah intinya.** Dua proses yang sama-sama bertanya "sudah pernah ada?" akan sama-sama dijawab "belum", lalu keduanya lanjut memproses. Yang melihat kedua permintaan sekaligus hanya basis data.

Bentuk port-nya yang membuat pola salah tidak dapat ditulis. [`WebhookLedger`](src/application/ports.ts) **tidak punya** operasi "sudah pernah ada?" yang berdiri sendiri — satu-satunya jalan masuk adalah `claim()`, yang menyisipkan dan melaporkan hasilnya sekaligus:

| Jawaban `claim()`   | Artinya                          | Yang dilakukan pemanggil               |
| ------------------- | -------------------------------- | -------------------------------------- |
| `claimed`           | Kita pemenangnya                 | Proses, lalu tutup dengan hasilnya     |
| `already_processed` | Sudah selesai sebelumnya         | Kembalikan hasil lama, tanpa efek      |
| `in_progress`       | Sudah diklaim, **belum** selesai | Jawab 409 agar penyedia mengirim ulang |

`in_progress` adalah keadaan yang paling mudah salah ditangani. Ia muncul ketika proses yang mengklaim mati sebelum menutup klaimnya. Memperlakukannya sebagai duplikat yang sudah selesai berarti notifikasi itu hilang selamanya dan pembayaran tertinggal `PENDING` tanpa ada yang akan mengubahnya — jadi ia dijawab 409, dan Midtrans mengirimnya lagi.

### Membuktikannya tanpa Postgres

Docker mati sejak Step 05, jadi tidak ada Postgres. Uji "sepuluh webhook identik serentak menghasilkan tepat satu efek" tetap ada dan tetap bermakna karena palsuannya **meniru batasan UNIK**: pemeriksaan dan penulisan terjadi dalam satu langkah sinkron, tanpa satu pun titik tunggu di antaranya — lihat `memoryWebhookLedger` di [`src/testing/stores.ts`](src/testing/stores.ts).

Bahwa uji itu tidak hampa dibuktikan **palsuan tandingan**: `racyWebhookLedger` memakai pola "periksa dulu baru tulis", dan uji yang sama padanya menghasilkan sepuluh efek. Kegagalan itu sendiri adalah sebuah uji yang tetap ada di suite:

```
✓ sepuluh webhook identik serentak menghasilkan tepat satu efek
✓ uji balapan tidak hampa: pola periksa-dulu-baru-tulis menghasilkan banyak efek
```

Pola yang sama dipakai untuk refund, dikunci `request_id`.

**Yang TETAP TIDAK dibuktikan:** bahwa Postgres sungguhan menegakkannya. Itu pekerjaan uji integrasi Step 20. Yang terbukti di sini adalah bahwa kode kita bergantung pada batasan itu dan tidak pada pemeriksaan di aplikasi.

## Tabel transisi, bukan rangkaian percabangan

Lima keadaan kali tiga hasil penyedia: lima belas sel, semuanya diputuskan di [`src/domain/payment.ts`](src/domain/payment.ts) dan semuanya diperiksa uji.

|                        | `PENDING` | `SUCCEEDED`  | `FAILED`     |
| ---------------------- | --------- | ------------ | ------------ |
| **PENDING**            | unchanged | apply        | apply        |
| **SUCCEEDED**          | unchanged | unchanged    | out_of_order |
| **FAILED**             | unchanged | out_of_order | unchanged    |
| **PARTIALLY_REFUNDED** | unchanged | unchanged    | out_of_order |
| **REFUNDED**           | unchanged | unchanged    | out_of_order |

Dua sel `out_of_order` pada baris `FAILED` dan `SUCCEEDED` adalah seluruh jawaban untuk "webhook tidak berurutan tidak merusak keadaan final". Ditulis sebagai rangkaian `if`, sel-sel itulah yang terlupa — dan yang terlupa pada penanganan webhook selalu sel yang sama: notifikasi yang tiba pada keadaan yang sudah final.

Notifikasi tidak berurutan **dicatat**, bukan dibuang diam-diam (`outcome = ignored_out_of_order`). Tanpa catatan itu, pertanyaan "kenapa pembayaran ini gagal padahal penyedia bilang berhasil" tidak dapat dijawab.

### Keadaan final tidak dapat dibuktikan dari satu tabel

Percobaan membuktikan "keadaan final tidak punya transisi keluar" dari tabel di atas saja **gagal**, dan kegagalannya yang menarik: `SUCCEEDED` dan `PARTIALLY_REFUNDED` tidak punya satu pun transisi keluar lewat notifikasi penyedia. Transisi keluar keduanya datang dari **refund**, dan refund bukan webhook.

Menyimpulkan finalitas dari tabel itu saja akan menyatakan pembayaran berhasil sebagai keadaan final padahal dana masih dapat dikembalikan. Buktinya karena itu tinggal di [`refund.test.ts`](src/domain/refund.test.ts), satu-satunya tempat kedua tabel terlihat sekaligus.

## Tanda tangan

`SHA-512(order_id + status_code + gross_amount + server_key)`, dibandingkan dengan `timingSafeEqual`.

Tiga hal yang layak disebut:

1. **`gross_amount` dipakai MENTAH.** Memformat ulang angkanya mengubah bahan tanda tangan dan membuat seluruh notifikasi yang sah ditolak — kegagalan yang terlihat persis seperti serangan.
2. **Ada uji jawaban-diketahui** yang membekukan satu nilai hash sungguhan. Uji yang hanya membandingkan fungsi dengan dirinya sendiri akan lulus meski urutan penggabungannya tertukar.
3. **Notifikasi bertanda tangan tidak sah tidak menyentuh buku besar sama sekali.** Kalau ia boleh menempati `provider_event_id`-nya, siapa pun yang mengetahui sebuah `transaction_id` dapat mengirim notifikasi palsu lebih dulu, dan notifikasi sungguhan yang tiba kemudian akan dianggap duplikat lalu diabaikan — pembayaran yang sah hilang tanpa jejak.

**Keterbatasan yang diakui:** perbandingan waktu tetap dan `===` menghasilkan jawaban yang sama untuk setiap masukan, jadi tidak ada uji perilaku yang dapat membedakannya. Penjagaannya bersifat **struktural** — sebuah uji membaca kode `signature.ts` dan menolak perbandingan kesetaraan apa pun di luar perbandingan panjang buffer. Ini bukti yang lebih lemah daripada uji perilaku. Uji pengukuran waktu sudah dipertimbangkan dan ditolak: ia rapuh pada mesin CI yang terbagi, dan uji keamanan yang kadang gagal adalah uji yang akan dimatikan.

## Pemetaan status Midtrans

Tabel di [`src/domain/provider-status.ts`](src/domain/provider-status.ts), bukan rangkaian percabangan — karena tabel membuat status yang **tidak** dipetakan menjadi terlihat.

| `transaction_status`                  | Hasil                            |
| ------------------------------------- | -------------------------------- |
| `capture`, `settlement`               | SUCCEEDED                        |
| `pending`, `authorize`                | PENDING                          |
| `deny`, `cancel`, `expire`, `failure` | FAILED                           |
| `refund`, `partial_refund`            | diabaikan                        |
| apa pun yang lain                     | `unsupported` — **bukan** FAILED |

Status tak dikenal yang jatuh ke `else` sebuah rangkaian `if` akan menandai pembayaran **gagal** padahal uangnya mungkin sudah masuk. Karena itu ia diabaikan dan dicatat, tidak ditebak.

Tiga baris yang **tidak** disebut Step 18 dan ditambahkan dengan alasan:

- `authorize` → PENDING. Kartu sudah disetujui penerbit tetapi dananya belum ditarik.
- `refund`, `partial_refund` → diabaikan. Keadaan refund dimiliki alur refund kita; menerapkan notifikasi ini membuat dua sumber kebenaran untuk satu fakta.
- **`capture` + `fraud_status: challenge` → PENDING, menimpa SUCCEEDED.** Satu-satunya penyimpangan sengaja dari tabel yang diminta step doc. `challenge` berarti Midtrans meminta keputusan manual: dananya tertahan dan belum tentu pernah masuk. Tanpa penimpaan ini, kamar dikonfirmasi ke supplier atas pembayaran yang masih mungkin dibatalkan.

`fraud_status` yang **tidak dikenal** juga menahan pembayaran, bukan meloloskannya. Nilai baru yang ditambahkan penyedia suatu hari lebih mungkin berarti "ada yang perlu diperiksa" daripada "aman" — dan menunggu dapat diperbaiki, sementara kamar yang sudah dikonfirmasi tidak.

## Nilai yang ditagih datang dari peristiwa, bukan dari permintaan

G2 menuntut pengguna tidak pernah dibebani nilai selain yang terakhir disetujuinya. Itu mustahil dijamin kalau nilainya datang dari pemanggil yang sama dengan yang meminta pembayaran.

Service ini karena itu **mendengarkan** `booking.created` dan `booking.price_changed` dari Kafka, dan menyimpan nilai yang boleh ditagih di tabel `payable_amounts`. Nilai pada permintaan pembayaran hanya **dibandingkan** dengannya; kalau berbeda, alurnya dihentikan dengan 409 dan pesan untuk memuat ulang harga.

`booking.price_changed` menang atas `booking.created` bukan karena jenisnya, melainkan karena **waktunya** — harga yang disetujui pengguna adalah yang terakhir ia setujui, dan harga bisa berubah dua kali.

Pemesanan yang belum punya catatan harga **ditolak**, bukan ditagih sebesar nilai permintaan.

Tidak ada panggilan langsung ke booking-service, sesuai ketentuan Step 18: komunikasi lewat peristiwa.

> **Catatan keadaan repo:** Step 16 dan Step 17 (booking-service) belum ada saat service ini dibuat. Kontrak peristiwa yang dipakai — `booking.created.amount` dan `booking.price_changed.newAmount` — sudah ada di `packages/event-contracts` sejak Step 05, jadi tidak ada kontrak baru yang ditebak. Yang belum terbukti adalah bahwa booking-service sungguhan menerbitkan keduanya pada saat yang diharapkan; itu pekerjaan Step 19.

## Uang

Seluruh nilai memakai [`@tbe/money`](../../packages/money). IDR bereksponen **0** — satuan terkecil rupiah adalah rupiah.

`gross_amount` dari Midtrans tiba sebagai **string desimal** (`"1250000.00"`), dan di situlah pecahan biner paling mudah menyelinap masuk. Penguraiannya dilakukan atas **digit**, bukan atas hasil `Number` dari keseluruhan string:

```
Number('10.23') * 100  ->  1022.9999999999999
```

`Number` dan `parseFloat` juga terlalu longgar untuk data dari luar: keduanya menerima `"1e5"`, `"0x10"`, `" 12 "`, dan `"12abc"` — sebagian dengan nilai yang sama sekali berbeda dari yang terlihat. Semuanya ditolak.

Rupiah dengan pecahan (`"1250000.50"`) **ditolak**, tidak dibulatkan diam-diam: tidak ada setengah rupiah, dan membulatkannya berarti menagih nilai yang berbeda dari yang dikirim penyedia.

Nilai notifikasi yang tidak cocok dengan nilai pembayaran ditolak dan dicatat sebagai **galat** — `gross_amount` termasuk yang ditandatangani, jadi selisih pada notifikasi yang tanda tangannya sah berarti catatan **kita** yang berbeda dari penyedia.

## Refund

Total refund tidak boleh melebihi nilai pembayaran, dan itu ditegakkan **di domain** — bukan hanya sebagai batasan basis data. Batasan basis data baru berbicara setelah baris ditulis, sementara panggilan refund ke penyedia terjadi sebelum itu. Menolak setelah uangnya keluar bukan penolakan, hanya laporan.

Refund yang **masih menunggu** ikut menghabiskan kuota. Kalau hanya yang sudah berhasil dihitung, dua permintaan yang masing-masing di bawah batas tetapi jumlahnya melebihi akan sama-sama lolos — dan keduanya sudah dikirim ke penyedia sebelum kelebihannya terlihat. Refund yang **gagal** membebaskan kuotanya kembali.

Idempotensinya bertumpu pada `refundRequestId` dan ditegakkan di **dua** tempat yang berbeda, karena keduanya menjaga hal yang berbeda:

- **Batasan UNIK `request_id`** menjaga terhadap balapan di sisi kita.
- **Pengenal yang sama diteruskan ke Midtrans** sebagai `refund_key`, karena batasan UNIK kita tidak dapat membatalkan refund yang sudah dikirim ke sistem orang lain.

Refund yang masih `PENDING` **dilanjutkan** saat perintah tiba lagi, bukan ditolak sebagai duplikat. Tanpa jalur itu, refund yang penyedianya sempat tidak dapat dihubungi akan terkunci selamanya oleh pengenal permintaannya sendiri — uang pengguna tertahan oleh mekanisme yang dipasang untuk melindunginya.

### Kegagalan refund dan dead letter

| Keadaan                           | Jawaban use case           | Yang dilakukan penangan consumer                                                               |
| --------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------- |
| Penyedia tidak dapat dihubungi    | `retryable`                | Melempar galat 502 → antrian tunda berjenjang (5s, 30s, 2m), lalu dead letter dengan **error** |
| Penyedia menolak permanen         | `rejected`                 | Melempar galat 409 → **langsung** dead letter, tanpa percobaan ulang                           |
| Tidak ada yang perlu dikembalikan | `rejected: not_refundable` | **Tidak** melempar — di-ack                                                                    |
| Sudah pernah berhasil             | `already_done`             | **Tidak** melempar — di-ack                                                                    |

Tingkat **error**, bukan peringatan, karena refund yang tidak pernah selesai berarti uang pengguna tertahan — dan peringatan tidak menuntut tindakan apa pun. Diuji lewat pembungkus consumer `@tbe/messaging` yang **sesungguhnya**, bukan lewat tiruan kebijakan percobaan ulang.

## Peristiwa terbit setelah keadaan tersimpan

Selalu, dan diuji atas **urutan** efek yang sesungguhnya:

```ts
expect(world.effects).toEqual([
  `update:${paymentId}:SUCCEEDED`,
  `event:payment.succeeded:${paymentId}`,
])
```

Peristiwa yang mendahului penyimpanan akan dibaca saga yang lalu menanyakan pembayaran yang belum ada — dan kegagalan itu hanya muncul ketika consumer cukup cepat, yang berarti ia muncul di produksi dan tidak muncul di mesin pengembang.

## Keamanan

- Endpoint webhook **tidak** memerlukan autentikasi pengguna — penyedia yang memanggilnya. Yang menggantikan autentikasi adalah tanda tangan.
- Endpoint webhook punya **pembatas laju sendiri**, karena ia tidak melewati api-gateway sama sekali. Pembatas berjalan **sebelum** verifikasi tanda tangan: satu SHA-512 per notifikasi palsu adalah biaya yang tidak perlu dibayar.
- Payload yang dicatat sudah **diredaksi**. `signature_key` yang tersimpan adalah setengah bahan untuk memalsukan notifikasi berikutnya.
- Kredensial hanya dari env, divalidasi skema Zod saat startup, di `config.ts` saja. Server key tidak pernah melewati lapisan aplikasi maupun domain: ia diikat di [`signature-verifier.ts`](src/infrastructure/signature-verifier.ts), dan akibat sampingnya berguna — palsuan untuk pengujian tidak membutuhkan kunci apa pun.
- Pesan galat tidak memuat detail internal. Alasan penolakan dari penyedia tidak diteruskan ke pengguna; ia masuk log dengan `correlationId`.

## Satu-satunya tempat Midtrans dihubungi

[`src/infrastructure/midtrans-gateway.ts`](src/infrastructure/midtrans-gateway.ts), di belakang port `PaymentGateway`.

Batas ini bukan formalitas: sandbox **tidak dapat diperintah gagal sesuai kehendak**, jadi chaos test Step 28 menyuntikkan kegagalan di port itu. Satu panggilan Midtrans dari luar berkas itu berarti ada jalur yang tidak dapat disuntik, dan jalur yang tidak dapat disuntik adalah jalur yang tidak pernah diuji terhadap kegagalan.

## Antarmuka

| Metode | Rute                     | Untuk                                                              |
| ------ | ------------------------ | ------------------------------------------------------------------ |
| `POST` | `/internal/payments`     | Membuat maksud pembayaran (FR-19)                                  |
| `GET`  | `/internal/payments/:id` | Keadaan pembayaran beserta refundnya                               |
| `POST` | `/webhooks/midtrans`     | Notifikasi penyedia (FR-20). **Publik**, diverifikasi tanda tangan |

Status HTTP pada endpoint webhook dibentuk oleh satu kenyataan: **Midtrans mengirim ulang notifikasi yang tidak dijawab 2xx.**

| Hasil                           | Status | Alasan                                                                                                                              |
| ------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| diterapkan, duplikat, diabaikan | 200    | Penyedia berhenti mengirim                                                                                                          |
| `in_progress`                   | 409    | Penyedia **harus** mengirim lagi                                                                                                    |
| tanda tangan tidak sah          | 401    | Tidak akan berubah, tetapi tidak boleh dijawab 200 — jawaban 200 pada notifikasi palsu membuatnya tidak terlihat di dasbor penyedia |
| pembayaran tak dikenal          | 404    | —                                                                                                                                   |
| nilai tidak cocok               | 409    | —                                                                                                                                   |

## Bukti suntikan

Aturan yang berlaku sejak Step 03: setiap penjagaan diuji terhadap pelanggaran yang **sengaja disuntikkan**. Menulis uji lalu melihatnya hijau tidak membuktikan apa-apa.

Lima belas suntikan, seluruhnya dipulihkan setelah diperiksa:

| #   | Pelanggaran yang disuntikkan                                     | Hasil        | Uji yang gagal |
| --- | ---------------------------------------------------------------- | ------------ | -------------- |
| S1  | Verifikasi tanda tangan dilewati                                 | GAGAL (baik) | 3              |
| S2  | Perbandingan tanda tangan memakai `===` biasa                    | GAGAL (baik) | 2              |
| S3  | Klaim buku besar memakai "periksa dulu baru tulis"               | GAGAL (baik) | 1              |
| S4  | Klaim belum selesai dianggap duplikat yang sudah selesai         | GAGAL (baik) | 2              |
| S5  | Batas total refund dilonggarkan (refund menunggu tidak dihitung) | GAGAL (baik) | 2              |
| S6  | Webhook tidak berurutan membalikkan keadaan final                | GAGAL (baik) | 5              |
| S7  | Peristiwa diterbitkan sebelum keadaan tersimpan                  | GAGAL (baik) | 1              |
| S8  | Idempotensi refund dilewati (tabrakan tetap dilanjutkan)         | GAGAL (baik) | 1              |
| S9  | `capture` + `challenge` dianggap berhasil                        | GAGAL (baik) | 2              |
| S10 | `gross_amount` dihitung dengan aritmetika pecahan biner          | GAGAL (baik) | 1              |
| S11 | Perbandingan harga yang disetujui dilewati                       | GAGAL (baik) | 5              |
| S12 | `booking.price_changed` memakai harga lama                       | GAGAL (baik) | 4              |
| S13 | Refund gagal permanen masuk dead letter sebagai peringatan       | GAGAL (baik) | 2              |
| S14 | Payload webhook dicatat tanpa redaksi                            | GAGAL (baik) | 1              |
| S15 | Pemesanan tanpa harga tercatat memakai nilai permintaan          | GAGAL (baik) | 3              |

Batas heksagonal diuji terpisah dengan impor terlarang:

```
apps/payment-service/src/domain/__injected-boundary.ts
  1:29  error  domain tidak boleh mengimpor dari infrastructure  boundaries/element-types
```

**Satu suntikan yang TIDAK tertangkap, dan itu temuan yang sesungguhnya.** Percobaan pertama S11 mengganti nilai yang ditagih dari `payable.amount` menjadi `input.amount`, dan **seluruh uji tetap lulus** — karena perbandingan kesetaraan yang berjalan lebih dulu sudah menjamin keduanya sama di titik itu. Artinya seluruh jaminan G2 bertumpu pada perbandingan itu sendirian, dan tidak ada uji perilaku yang dapat membedakan kedua penulisannya. Tanggapannya: perbandingan dua bidang dengan tangan digantikan `equals` dari `@tbe/money`, supaya ia ikut berubah bersama tipenya alih-alih diam-diam berhenti lengkap. Suntikan S11 lalu diarahkan ke perbandingan itu sendiri.

## Uji

```bash
pnpm --filter @tbe/payment-service test
```

251 uji. Cakupan: **98,25% pernyataan, 97,39% cabang, 100% fungsi, 98,07% baris** — ambang step ini 85%.

Enam baris yang tidak tersentuh, seluruhnya disebutkan apa adanya:

- tiga blok `catch (error) { next(error) }` pada rute HTTP — penangkap galat tak terduga di batas sistem (CONVENTIONS.md bagian 5). Satu di antaranya **diuji** lewat repository yang sengaja melempar; sisanya tidak.
- satu `throw` di `refund-payment.ts` untuk keadaan yang tidak dapat terjadi (refund hilang tepat setelah disisipkan). Penjaga cacat program, bukan keadaan sah.
- satu nilai bawaan `?? ''` di `gross-amount.ts` yang dituntut tipe tetapi tidak dapat tercapai: grup regex-nya wajib, jadi ia selalu ada.

Adapter Prisma, Kafka, dan Midtrans **dikecualikan** dari cakupan unit — menguji pemetaan ORM dengan tiruan hanya menguji tiruannya. Keduanya jatah uji integrasi Step 20.

## Menjalankan

```bash
cp apps/payment-service/.env.example apps/payment-service/.env
# isi MIDTRANS_SERVER_KEY dan MIDTRANS_CLIENT_KEY dari dasbor sandbox
pnpm infra:up
pnpm --filter @tbe/payment-service db:migrate
pnpm --filter @tbe/payment-service dev
```

## Perintah verifikasi yang BELUM dijalankan

Docker Desktop mati sejak Step 05. Tidak ada Postgres, Redis, Kafka, maupun RabbitMQ yang dapat dijalankan, jadi perintah di bawah **belum pernah dijalankan** dan tidak ada klaim yang dibuat tentang hasilnya.

| Perintah                                            | Yang diharapkan                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @tbe/payment-service db:migrate`     | Migrasi `20260925000000_init` berlaku bersih pada basis data kosong. Migrasinya sendiri **sudah** dihasilkan offline dengan `prisma migrate diff --from-empty --to-schema`, dan memuat ketiga indeks unik yang menegakkan idempotensi.                                                              |
| Uji integrasi idempotensi (Step 20)                 | Sepuluh `INSERT` serentak dengan `provider_event_id` sama pada Postgres sungguhan menghasilkan satu baris, dan sembilan lainnya dijawab tanpa efek. **Inilah satu-satunya bukti bahwa batasan UNIK benar-benar menegakkannya**; palsuan di repo ini hanya membuktikan kode kita bergantung padanya. |
| Uji integrasi transaksi refund (Step 20)            | `insertRefund` menulis baris refund dan status pembayaran dalam satu transaksi; mengganti `$transaction` dengan dua penulisan terpisah harus menggagalkan ujinya.                                                                                                                                   |
| Notifikasi sungguhan dari sandbox Midtrans          | Tanda tangan yang dihitung service cocok dengan `signature_key` yang dikirim Midtrans. Uji jawaban-diketahui di repo memakai kunci contoh, jadi yang terbukti adalah algoritmanya — **bukan** bahwa bahan yang dipakai sama dengan yang dipakai Midtrans.                                           |
| `pnpm topics:create` lalu konsumsi `tbe.booking.v1` | Consumer peristiwa pemesanan benar-benar menerima `booking.created` dan `booking.price_changed`, dan `payable_amounts` terisi. Selama ini belum terbukti, `POST /internal/payments` akan **selalu** menolak dengan `amount_unknown` pada sistem yang berjalan.                                      |
| Pembatas laju Redis                                 | `createRedisWebhookRateLimiter` berbagi hitungan antar replika. Yang diuji sekarang hanya port-nya lewat palsuan.                                                                                                                                                                                   |
