# voucher-service

Menerbitkan e-voucher: bukti pemesanan yang sah dalam bentuk PDF. Memenuhi FR-24 dan M7.

Port 4008. Contoh consumer RabbitMQ untuk pekerjaan berat yang tidak boleh membuat pengguna menunggu.

## Alur

```
saga booking-service ──voucher.generate──▶ RabbitMQ ──▶ voucher-service
                                                         │
     booking-service  GET /internal/bookings/:id/voucher-source ◀┤ bahan pemesanan
     search-service   GET /internal/catalog/properties/by-supplier/... ◀┤ nama, alamat, kontak
                                                         │
                                       PDFKit ──▶ MinIO (bucket vouchers, kunci acak)
                                                         │
                                       Postgres (metadata, UNIK booking_id)
                                                         │
                                       Kafka voucher.issued ──▶ notification-service (Step 24)
```

Kedua rute `/internal` tidak dirutekan api-gateway. Daftar rutenya hanya memuat awalan publik.

## Idempoten terhadap bookingId

Perintah yang sama dua kali, atau dua consumer yang berpacu, menghasilkan **satu** voucher:

1. Voucher yang sudah ada langsung dikembalikan, tanpa menyusun PDF lagi.
2. Dua penerbitan serentak sama-sama mengunggah, tetapi hanya satu yang lolos batasan UNIK `booking_id`. Yang kalah menghapus berkasnya sendiri lalu mengembalikan voucher pemenang.

`voucher.issued` diterbitkan ulang untuk voucher yang sudah ada, dengan eventId = id voucher. Pengumuman yang hilang karena proses mati di antara "simpan" dan "terbitkan" dipulihkan oleh perintah berikutnya. Pembacanya mengenali duplikat lewat eventId.

Uji integrasi membuktikan keduanya terhadap Postgres dan MinIO sungguhan.

## Kegagalan

| Keadaan                                                            | Jalur                                            |
| ------------------------------------------------------------------ | ------------------------------------------------ |
| Pemesanan tidak ada, belum CONFIRMED, atau tanpa booking reference | dead letter langsung (409)                       |
| Properti belum terpetakan, atau snapshot katalog belum termuat     | tunda berjenjang (503), lalu dead letter         |
| booking-service, katalog, MinIO, Postgres, atau Kafka tersendat    | tunda 5 detik → 30 detik → 2 menit → dead letter |

404 hanya dianggap "tidak ada" bila membawa amplop galat `NOT_FOUND` dari service itu sendiri. 404 telanjang (URL salah, rute belum dikerahkan) dicoba lagi.

Jenjang tunda pertama yang 5 detik menjaga M7 tetap tercapai saat satu dependensi tersendat sesaat.

## Akses unduhan

`GET /vouchers/:bookingId` (lewat gateway, wajib masuk) mengembalikan `{ url, expiresAt }`:

- **Kepemilikan diperiksa** terhadap pemilik yang tercatat saat voucher terbit. Voucher milik orang lain dijawab 404, bukan 403, karena 403 mengonfirmasi bahwa pemesanannya ada.
- **URL bertanda tangan berumur 5 menit**, dengan `cache-control: no-store`. URL yang bocor lewat riwayat peramban atau log proxy cepat kedaluwarsa.
- Pemesanan yang belum CONFIRMED dijawab `409 BOOKING_NOT_CONFIRMED` dengan pesan yang jelas. Pemesanan yang sudah CONFIRMED tetapi vouchernya belum terbit dijawab `409 VOUCHER_NOT_READY`.

Kunci objek adalah token acak 256-bit (`v/<token>.pdf`) dan tidak diturunkan dari bookingId. Hubungan keduanya hanya tercatat di basis data service ini.

URL ditandatangani untuk `MINIO_PUBLIC_URL`, yaitu alamat yang dibuka peramban, karena tanda tangan S3 mencakup nama host.

## PDF

A4, hitam di atas putih, dengan fon bawaan PDF (Times untuk judul, Helvetica untuk isi). Kode QR berisi booking reference supplier dan digambar sebagai vektor. Isi teksnya disusun di [`domain/voucher-content.ts`](src/domain/voucher-content.ts) sebagai fungsi murni; penyusun PDF hanya menata letak.

Uji PDF mengekstrak teks dari berkasnya (`unpdf`) untuk memastikan seluruh field wajib ada, termasuk saat nama properti sangat panjang. Uji yang sama memeriksa bahwa setiap operator warna di PDF bernilai abu-abu (r = g = b).

## M7

Histogram `voucher_issue_latency_seconds` mencatat selisih dari `confirmedAt` (waktu transisi pemesanan ke CONFIRMED) sampai voucher terbit. p95:

```promql
histogram_quantile(0.95, sum by (le) (rate(voucher_issue_latency_seconds_bucket[5m])))
```

Selisih yang sama dibawa `voucher.issued.latencyMs` dan dapat dihitung ulang dari kolom `issued_at - confirmed_at`.

## Menjalankan

```bash
cp .env.example .env
pnpm --filter @tbe/voucher-service db:deploy
pnpm --filter @tbe/voucher-service build && pnpm --filter @tbe/voucher-service start

pnpm --filter @tbe/voucher-service test              # unit, cakupan ≥ 85%
pnpm --filter @tbe/voucher-service test:integration  # Postgres + MinIO lewat Testcontainers
```

Bucket `vouchers` dibuat oleh `pnpm infra:up` (minio-init), bukan oleh service ini. Service menolak startup bila bucket tersebut tidak ada.
