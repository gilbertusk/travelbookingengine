# api-gateway

Satu-satunya pintu masuk publik. Frontend tidak pernah berbicara langsung ke service mana pun — seluruh trafik klien lewat sini.

Gateway **tidak memuat satu pun aturan bisnis**. Kalau sebuah keputusan membutuhkan pengetahuan tentang pemesanan, harga, atau ketersediaan, tempatnya bukan di sini.

## Menjalankan

```bash
cp apps/api-gateway/.env.example apps/api-gateway/.env
pnpm infra:up
pnpm --filter @tbe/api-gateway dev
```

`JWT_SECRET` harus sama persis dengan milik auth-service. Kalau berbeda, seluruh token yang sah akan ditolak dengan 401.

## Tabel rute

Tabel ini adalah cerminan langsung dari [`src/domain/routes.ts`](src/domain/routes.ts). Rute dideklarasikan sebagai data di satu berkas, bukan tersebar sebagai pemanggilan `app.use` — supaya seluruhnya dapat ditinjau sekaligus, dan supaya rute yang lupa ditandai butuh autentikasi terlihat saat membaca sepuluh baris.

Pencocokan memakai **awalan terpanjang**, bukan urutan daftar, dan hanya berhenti pada batas segmen path (`/searching` tidak cocok dengan `/search`).

| Path                | Metode     | Service   | Autentikasi | Batas laju      | Batas waktu |
| ------------------- | ---------- | --------- | ----------- | --------------- | ----------- |
| `/auth/login`       | `POST`     | auth      | —           | `sensitive`     | 10s         |
| `/auth/register`    | `POST`     | auth      | —           | `sensitive`     | 10s         |
| `/auth/refresh`     | `POST`     | auth      | —           | `sensitive`     | 10s         |
| `/auth/*`           | seluruhnya | auth      | —¹          | `public`        | 10s         |
| `/search/*`         | seluruhnya | search    | —           | `search`        | 3s          |
| `/properties/*`     | seluruhnya | search    | —           | `search`        | 3s          |
| `/bookings/stream`  | `GET`      | booking   | **Bearer**  | `authenticated` | 300s (SSE)  |
| `/bookings/*`       | seluruhnya | booking   | **Bearer**  | `authenticated` | 10s         |
| `/payments/webhook` | `POST`     | payment   | —²          | `public`        | 20s         |
| `/payments/*`       | seluruhnya | payment   | **Bearer**  | `authenticated` | 20s         |
| `/vouchers/*`       | seluruhnya | voucher   | **Bearer**  | `authenticated` | 10s         |
| `/health/live`      | `GET`      | — (lokal) | —           | —               | —           |
| `/health/ready`     | `GET`      | — (lokal) | —           | —               | —           |
| `/metrics`          | `GET`      | — (lokal) | —           | —               | —           |

¹ Token tetap diverifikasi bila dikirim, dan identitasnya diteruskan — auth-service sendiri yang menolak `/auth/me` tanpa token. Gateway tidak perlu tahu endpoint mana di dalam `/auth` yang butuh sesi.

² Webhook penyedia pembayaran tidak membawa token pengguna. Keasliannya diverifikasi lewat tanda tangan di payment-service, bukan di sini — gateway tidak boleh memegang kunci penyedia.

Batas waktu sengaja berbeda per jenis rute. Pencarian menembak lima supplier dan punya anggaran waktunya sendiri; pembayaran menunggu penyedia luar; SSE dibiarkan hidup sampai klien menutupnya.

## Batas laju

Berbasis Redis lewat `rate-limiter-flexible`, jadi kuota dihitung lintas replika. Pembatas dalam memori tidak berarti apa-apa begitu gateway digandakan: sepuluh replika masing-masing mengizinkan kuota penuh.

| Kelas           | Kuota       | Dipakai oleh                                 |
| --------------- | ----------- | -------------------------------------------- |
| `sensitive`     | 10 / menit  | Masuk, daftar, refresh — pintu yang diserang |
| `search`        | 40 / menit  | Pencarian, karena satu permintaan mahal      |
| `public`        | 120 / menit | Penjelajahan anonim                          |
| `authenticated` | 300 / menit | Pemesanan, pembayaran, voucher               |

Kunci hitungan adalah `user:<id>` bila ada identitas terverifikasi, selain itu `ip:<alamat>`. Header `RateLimit-Limit`, `RateLimit-Remaining`, dan `RateLimit-Reset` dikembalikan pada **setiap** respons, bukan hanya saat menolak — klien yang hanya tahu batasnya setelah tertolak tidak dapat mengatur lajunya sendiri.

## Identitas

Gateway memverifikasi token; service hulu mempercayai hasilnya. Konsekuensinya hanya gateway dan auth-service yang perlu memegang rahasia penandatanganan — sembilan service lain tidak, dan karena itu tidak dapat membocorkannya.

Identitas diteruskan lewat header internal:

| Header             | Isi                     |
| ------------------ | ----------------------- |
| `x-tbe-user-id`    | `sub` dari access token |
| `x-tbe-user-email` | `email` dari token      |

**Seluruh header berawalan `x-tbe-` yang datang dari klien dibuang lebih dulu**, sebelum yang terverifikasi ditambahkan. Ini bukan kerapian: tanpa pembuangan itu, siapa pun dapat mengirim `x-tbe-user-id` sendiri dan service hulu akan mempercayainya. Pembuangan dilakukan berdasarkan awalan, bukan daftar nama, supaya header internal baru tidak diam-diam menjadi celah sampai seseorang ingat memperbarui daftarnya.

Diuji di [`src/http/gateway.test.ts`](src/http/gateway.test.ts) dan [`src/domain/routes.test.ts`](src/domain/routes.test.ts).

## Urutan middleware

Urutannya menentukan perilaku keamanan, jadi ditulis eksplisit di [`src/composition/app.ts`](src/composition/app.ts):

```
correlation → health/metrics → penjaga metode → identitas → batas laju → proxy
```

- **Identitas sebelum batas laju**, supaya kuota dihitung per pengguna dan bukan per alamat IP — kalau terbalik, seluruh pengguna di balik satu NAT berbagi satu kuota.
- **Health dan metrics sebelum batas laju**, supaya pemantauan tidak ikut kehabisan kuota saat sistem sedang bermasalah — persis saat pemantauan paling dibutuhkan.

## Kegagalan hulu

| Keadaan                       | Respons                      |
| ----------------------------- | ---------------------------- |
| Batas waktu terlampaui        | `504` `TIMEOUT`              |
| Service tidak dapat dihubungi | `503` `UPSTREAM_UNAVAILABLE` |
| Rute tidak dikenal            | `404` `NOT_FOUND`            |
| Metode tidak diizinkan        | `405` dengan header `Allow`  |

Keduanya dibedakan dengan sengaja: pada batas waktu, hulu mungkin sudah mengerjakan permintaannya — pada koneksi yang ditolak, pasti belum. Perbedaan itu yang menentukan apakah aman mencoba lagi.

Pesan galat 5xx tidak pernah memuat nama host, port, atau alamat internal. Ada test yang secara khusus memeriksa hal ini.

## Server-Sent Events

`/bookings/stream` diteruskan tanpa buffering: `x-accel-buffering: no`, `cache-control: no-cache, no-transform`, header dikirim segera. Tanpa itu, proxy di depan gateway akan menahan potongan aliran sampai buffer penuh, dan pembaruan status pemesanan tiba dalam gumpalan alih-alih mengalir.

## Health check

`/health/ready` memeriksa keterjangkauan seluruh service hulu sekaligus dan melaporkan per service. `/health/live` hanya melaporkan bahwa proses gateway hidup — memasukkan hulu ke dalam liveness akan membuat orkestrator membunuh gateway yang sebenarnya sehat hanya karena satu service hulu sedang tumbang.

## Struktur

```
src/
├── domain/          routes.ts (tabel rute), identity.ts — tanpa I/O
├── application/     ports.ts — antarmuka yang dibutuhkan, bukan implementasinya
├── infrastructure/  undici-upstream.ts, jose-verifier.ts, rate-limiters.ts
├── http/            proxy.ts, authenticate.ts, rate-limit.ts, method-guard.ts
├── composition/     app.ts — satu-satunya tempat semuanya dirangkai
└── testing/         fakes.ts
```

Arah ketergantungan ditegakkan `eslint-plugin-boundaries`: `domain` tidak boleh mengimpor apa pun dari lapisan lain.

## Pengujian

```bash
pnpm --filter @tbe/api-gateway test
```

74 test. Adapter hulu diuji terhadap server HTTP sungguhan dan verifier terhadap token yang benar-benar ditandatangani — termasuk token `alg=none`, yang harus ditolak.

**Belum diverifikasi:** pembatas laju berbasis Redis baru diuji pembangunannya, belum perilakunya terhadap Redis yang berjalan. Lihat [docs/plan/step-08-api-gateway.md](../../docs/plan/step-08-api-gateway.md).
