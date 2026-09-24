# @tbe/supplier-adapters

Menerjemahkan lima antarmuka supplier yang berbeda-beda menjadi satu model kanonik.

Di balik `SupplierGateway`, SOAP dengan tanggal `DD/MM/YYYY` dan JSON dengan epoch detik menjadi hal yang sama. Pemanggil — search-service, booking-service — tidak pernah tahu supplier mana yang berbicara XML.

## Yang BUKAN tanggung jawab paket ini

Paket ini murni penerjemahan:

| Bukan di sini                    | Ada di                                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------------------- |
| Percobaan ulang, pemutus sirkuit | Step 11 — supplier-service                                                                      |
| Cache                            | Step 11 dan Step 13                                                                             |
| Konversi mata uang               | Step 12 — pricing-service                                                                       |
| Anggaran waktu fan-out pencarian | Step 13 — search-service                                                                        |
| Pemetaan ke pengenal internal    | Step 12b — katalog, lihat [ADR-0001](../../docs/adr/0001-identitas-properti-lintas-supplier.md) |

Tidak ada ketergantungan pada Express, Kafka, maupun RabbitMQ.

## Lima supplier, lima cara berbicara

| Kode      | Protokol  | Mata uang | Yang harus ditangani adapter                                       |
| --------- | --------- | --------- | ------------------------------------------------------------------ |
| **SKY**   | REST JSON | IDR       | camelCase, harga satuan terkecil — yang paling lurus               |
| **NOVA**  | REST JSON | USD       | snake_case, harga desimal, tanggal datetime, rate plan tanpa kamar |
| **ORBIT** | SOAP XML  | IDR       | PascalCase, tanggal `DD/MM/YYYY`, elemen tunggal bukan larik       |
| **LUNA**  | REST JSON | IDR       | nama field terpangkas, boolean `0`/`1`, tanggal epoch detik        |
| **ZEPH**  | REST JSON | USD       | harga dan angka sebagai string, amplop `{ status, payload }`       |

Setiap adapter berbentuk sama: satu pabrik yang hanya merangkai, dan satu fungsi per operasi. Membaca satu berarti dapat membaca kelimanya.

## Jebakan yang ditangani, dan kenapa

**Tanggal `DD/MM/YYYY` milik ORBIT** dibaca hari-dulu. Parser yang mengasumsikan urutan Amerika membaca `01/10/2026` sebagai 10 Januari — dan kesalahan itu hanya terlihat pada tanggal di atas 12, artinya lolos seluruh pengujian yang kebetulan memakai tanggal kecil. Pengujian di sini memakai tanggal 25 dan 31.

**Harga desimal** diubah ke satuan terkecil dengan operasi string, bukan perkalian pecahan. `Math.round(Number('8.115') * 100)` menghasilkan 811, bukan 812. Selisih satu sen per pemesanan tidak terlihat di layar mana pun dan muncul sebagai angka yang tidak cocok saat rekonsiliasi.

**Pemisah ribuan** diterima. `Number('1,250.00')` menghasilkan NaN, dan NaN yang lolos menjadi harga akan tampil sebagai "Rp NaN" — atau, lebih buruk, menjadi 0 setelah pembulatan.

**Desimal yang lebih rinci daripada satuan terkecilnya ditolak**, bukan dibulatkan. Supplier yang mengirim `267.835` untuk USD sedang menyatakan sesuatu yang tidak dapat diwakili; membulatkannya diam-diam berarti menagih pengguna dengan angka yang tidak pernah disebut siapa pun.

**Elemen XML tunggal** selalu dijadikan larik. Satu hotel dalam hasil datang sebagai objek, dua hotel sebagai larik — kode yang langsung memanggil `.map()` bekerja sempurna sampai ada pencarian yang hanya menemukan satu.

**Fault SOAP dengan status 200** tetap menjadi kegagalan. Membaca status saja akan meneruskannya sebagai hasil yang sah.

**Mata uang ditandai, tidak dikonversi.** Adapter yang diam-diam mengonversi membuat mustahil mengetahui harga asli supplier — dan harga asli itulah yang dipakai saat rekonsiliasi.

## Jenis kegagalan

`SupplierError` adalah union diskriminan, bukan satu kelas galat. Pembedaannya menjadi fondasi Step 11 dan Step 19:

| Jenis               | Layak diulang? | Aman diulang langsung? |
| ------------------- | -------------- | ---------------------- |
| `timeout`           | ya             | **tidak**              |
| `unavailable`       | ya             | ya                     |
| `rate_limited`      | ya             | ya                     |
| `upstream_error`    | ya             | **tidak**              |
| `invalid_response`  | tidak          | —                      |
| `not_found`         | tidak          | —                      |
| `sold_out`          | tidak          | —                      |
| `price_changed`     | tidak          | —                      |
| `hold_expired`      | tidak          | —                      |
| `already_cancelled` | tidak          | —                      |

Kolom kedua dan ketiga berbeda, dan perbedaannya menentukan uang sungguhan. Mencoba ulang `sold_out` adalah pemborosan murni. Mencoba ulang `timeout` **tanpa memeriksa status lebih dulu** adalah penyebab pemesanan ganda: batas waktu berarti supplier mungkin sudah membuat pemesanan dan hanya responsnya yang tidak sampai.

Jalan keluarnya adalah `findBookingByIdempotencyKey` — bertanya dengan kuncinya adalah satu-satunya cara aman mencari tahu.

Kelima supplier memakai 409 untuk empat keadaan yang berbeda artinya. Kode di dalam badan responslah yang membedakan, dan letaknya berbeda pada setiap supplier: `error` di SKY, `error_code` di NOVA, `<Fault><Code>` di ORBIT, `err` di LUNA, `error.code` di ZEPH.

## Fixture

Seluruh fixture ditangkap dari mock-supplier yang benar-benar berjalan, bukan ditulis tangan:

```bash
pnpm --filter @tbe/mock-supplier dev
pnpm --filter @tbe/supplier-adapters fixtures:capture
```

Fixture buatan hanya membuktikan adapter cocok dengan apa yang penulisnya bayangkan. Yang perlu dibuktikan adalah adapter cocok dengan apa yang supplier benar-benar kirimkan — termasuk keanehan yang tidak terpikirkan saat menulis adapter.

30 fixture: pencarian, price check, hold, pemesanan, pengambilan, pembatalan, dan pengambilan setelah pembatalan, untuk kelima supplier.

## Pemakaian

```ts
import { createSupplierRegistry, mockSupplierRegistryConfig } from '@tbe/supplier-adapters'

const registry = createSupplierRegistry(mockSupplierRegistryConfig('http://localhost:4000'))

const result = await registry.get('ORBIT').search({
  city: 'Bali',
  checkIn: '2026-11-10',
  checkOut: '2026-11-12',
  guests: 2,
})

if (!result.ok) {
  // result.error.kind memberi tahu apakah layak dicoba ulang
}
```

Alamat supplier datang dari konfigurasi, tidak tertanam — satu alamat yang tertulis di dalam kode adalah alamat yang akan ikut terbawa ke produksi.

## Pengujian

```bash
pnpm --filter @tbe/supplier-adapters test
```

175 test. Yang dipalsukan hanya transport; penguraian, validasi, dan normalisasi dijalankan sungguhan terhadap respons yang benar-benar pernah dikirim. Batas waktu dan koneksi yang ditolak diuji terhadap server HTTP sungguhan — keduanya hanya muncul dari soket nyata.
