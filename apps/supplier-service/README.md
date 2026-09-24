# supplier-service

Membungkus seluruh komunikasi dengan supplier dengan lapisan ketahanan. Service ini yang membuat pernyataan **"satu supplier mati tidak menurunkan sistem"** menjadi sesuatu yang dapat dibuktikan, bukan sekadar diklaim.

Memenuhi NFR-03, NFR-04, dan NFR-14.

## Yang paling penting di sini

**`book` yang kehabisan waktu tidak pernah diulang begitu saja.**

Ini implementasi US-05, dan satu-satunya bagian project ini yang secara langsung mencegah kerugian uang sungguhan. Ketika `book` kehabisan waktu, sistem **tidak tahu** apakah pemesanan terbentuk — supplier mungkin sudah membuatnya dan hanya responsnya yang tidak sampai. Mengulang `book` dalam keadaan itu menghasilkan **pemesanan kedua**: kamar kedua yang dibayar, tagihan yang harus dikembalikan, dan pengguna yang menerima dua surel konfirmasi.

```
book → timeout
     → findBookingByIdempotencyKey(kunci yang sama)
         → ketemu     → adopsi. Selesai. Tidak ada pemesanan kedua.
         → not_found  → supplier memang belum menerimanya.
                        Baru sekarang `book` boleh diulang.
         → gagal lagi → TIDAK DAPAT DIPASTIKAN. Dilaporkan apa adanya,
                        bukan ditebak.
```

Keadaan `uncertain` bukan kegagalan dan bukan keberhasilan. Menebak "gagal" meninggalkan pemesanan hantu yang tetap ditagih; menebak "berhasil" menjanjikan kamar yang mungkin tidak ada. Rekonsiliasi Step 28 yang menuntaskannya.

Diuji di [`src/application/confirm-booking.test.ts`](src/application/confirm-booking.test.ts) — 16 test, dan setiap satu memeriksa **urutan panggilan yang benar-benar dikirim**, bukan hanya hasil akhirnya. Hasil akhir yang benar dengan dua `book` terkirim tetap berarti dua kamar yang dibayar.

## Menjalankan

```bash
cp apps/supplier-service/.env.example apps/supplier-service/.env
pnpm infra:up
pnpm --filter @tbe/supplier-service db:migrate
pnpm --filter @tbe/supplier-service db:seed
pnpm --filter @tbe/mock-supplier dev
pnpm --filter @tbe/supplier-service dev
```

Seed wajib: direktori supplier yang kosong membuat service menyatakan dirinya belum siap, dan itu disengaja — tanpa satu pun supplier terdaftar, tidak ada yang dapat dipanggil.

## Pemutus sirkuit

Satu pemutus **per supplier per operasi**. Pencarian yang tumbang tidak berarti pemesanan ikut tumbang.

| Keadaan     | Arti                             |
| ----------- | -------------------------------- |
| `closed`    | Normal                           |
| `open`      | Ditolak tanpa menyentuh jaringan |
| `half_open` | Satu percobaan diizinkan lewat   |

Pemutus yang terbuka melewati durasinya **tidak langsung tertutup**. Ia menjadi setengah terbuka, dan butuh **dua** keberhasilan berturut-turut untuk menutup penuh. Supplier yang baru pulih kerap berhasil sekali lalu gagal lagi; menutup setelah satu keberhasilan mengirim seluruh trafik ke supplier yang belum benar-benar pulih, dan pemutusnya membuka lagi seketika — berayun tanpa henti.

**Keadaannya hidup di Redis, bukan di memori proses.** Pemutus yang hitungannya per-instance berarti sepuluh replika masing-masing harus menembak supplier yang sudah jelas tumbang sebanyak lima kali sebelum berhenti — lima puluh panggilan sia-sia ke sistem yang sedang berusaha bangkit. Pencatatan hasilnya berjalan sebagai baca-lalu-tulis bersyarat, karena dua instance yang gagal bersamaan akan sama-sama membaca hitungan lama dan ambangnya tidak pernah tercapai.

Mesin keadaannya sendiri adalah fungsi murni di [`src/domain/circuit.ts`](src/domain/circuit.ts) — tanpa Redis, tanpa waktu yang dibaca sendiri, tanpa I/O. Itulah yang membuat pemulihan bertahap, bagian yang paling sulit dibuat benar, dapat dibuktikan tanpa satu proses pun berjalan dan tanpa menunggu tiga puluh detik.

### Yang TIDAK dihitung sebagai kegagalan

Kamar habis bukan kegagalan supplier — itu jawaban yang benar dari supplier yang sehat. Menghitungnya akan membuka pemutus tepat pada saat permintaan sedang tinggi, yaitu saat supplier paling dibutuhkan.

`rate_limited` juga tidak dihitung: supplier sedang melindungi dirinya, dan yang harus menyesuaikan adalah pembatas laju keluar kita.

## Kebijakan percobaan ulang

Seluruhnya diturunkan dari jenis `SupplierError` yang dibedakan Step 10 — inilah pembayaran atas pembedaan yang di sana terlihat berlebihan.

| Jenis                                                    | Diulang?  | Catatan                                |
| -------------------------------------------------------- | --------- | -------------------------------------- |
| `timeout`, `upstream_error`                              | ya        | backoff eksponensial dengan jitter     |
| `unavailable`                                            | ya        | supplier pasti belum menerimanya       |
| `rate_limited`                                           | ya        | jeda mengikuti `Retry-After` supplier  |
| `invalid_response`                                       | **tidak** | akan cacat lagi; yang dibutuhkan orang |
| `sold_out`, `not_found`, `price_changed`, `hold_expired` | **tidak** | jawaban yang sah                       |

Jitter bukan hiasan: tanpa jitter, seluruh permintaan yang gagal bersamaan akan dicoba ulang bersamaan juga, dan supplier yang baru tumbang menerima gelombang kedua tepat pada detik yang sama.

**`book` tidak tunduk pada kebijakan ini sama sekali.** Percobaan ulang otomatis dimatikan untuknya; keputusan mengulang diambil setelah status sebenarnya diketahui.

## Pembatasan laju keluar

Token bucket per supplier di Redis. Arahnya **berlawanan** dengan pembatas di api-gateway: yang di sana melindungi kita dari klien, yang ini melindungi supplier dari kita (NFR-14). Sistem yang menggandakan diri saat trafik naik dapat membanjiri supplier tanpa sengaja, dan supplier yang tumbang karena kita adalah kerusakan yang kita sendiri sebabkan.

Token bucket, bukan jendela tetap: burst pendek pada awal pencarian — lima permintaan ke lima supplier sekaligus — harus lewat, sementara laju rata-ratanya tetap terjaga.

## Pencatatan permintaan

Setiap **percobaan** menjadi barisnya sendiri di `supplier_requests`, bukan memperbarui baris pertama. Riwayat percobaan itulah yang dibaca saat menelusuri pemesanan yang statusnya tidak pasti: tanpa baris kedua, tidak ada cara mengetahui bahwa `book` pernah kehabisan waktu sebelum akhirnya berhasil.

Payload diredaksi **berdasarkan nama field**, bukan berdasarkan isinya. Menebak dari isi — "string sepanjang 32 karakter heksadesimal" — akan meredaksi pengenal pemesanan yang justru paling dibutuhkan saat menelusuri.

Kegagalan mencatat **tidak** menggagalkan panggilan ke supplier. Pemesanan yang berhasil lalu dibatalkan karena barisnya gagal ditulis adalah kerugian yang jauh lebih besar daripada satu catatan yang hilang.

## Kredensial supplier

**Tidak disimpan di basis data.** Tabel `suppliers` hanya menyimpan NAMA variabel env-nya (`credentialRef`); nilainya dibaca saat perangkaian. Basis data yang bocor tidak boleh sekaligus menjadi bocornya akses ke seluruh supplier.

## Antarmuka

Dua jalur masuk, **satu use case**. Tidak ada logika bisnis di lapisan masuk — kalau ada, dua jalur akan berperilaku berbeda, dan perbedaannya baru ketahuan saat salah satunya dipakai sungguhan di produksi.

| Jalur         | Dipakai                               |
| ------------- | ------------------------------------- |
| HTTP internal | search-service, booking-service       |
| RabbitMQ      | `supplier.confirm`, `supplier.cancel` |

| Metode  | Rute                              | Keterangan                             |
| ------- | --------------------------------- | -------------------------------------- |
| `POST`  | `/internal/suppliers/search`      |                                        |
| `POST`  | `/internal/suppliers/price-check` | Tidak pernah dari cache                |
| `POST`  | `/internal/suppliers/hold`        |                                        |
| `POST`  | `/internal/suppliers/confirm`     | 202 bila status tidak dapat dipastikan |
| `POST`  | `/internal/suppliers/cancel`      |                                        |
| `GET`   | `/internal/suppliers`             | Konfigurasi kelima supplier            |
| `PATCH` | `/internal/suppliers/:code`       | FR-29 — aktif/nonaktif, ambang pemutus |

Tidak satu pun terdaftar di api-gateway. Lapisan ketahanan tidak punya apa pun yang perlu dilihat pengguna.

`uncertain` dibalas **202**, bukan 500. 500 akan membuat pemanggil mencobanya lagi — tepat hal yang seluruh mekanisme ini ada untuk mencegahnya.

## Metrik

| Metrik                              | Label                        |
| ----------------------------------- | ---------------------------- |
| `supplier_request_duration_seconds` | supplier, operation, outcome |
| `supplier_circuit_state`            | supplier, operation          |
| `supplier_retry_total`              | supplier, operation          |

`supplier_circuit_state`: 0 tertutup, 1 setengah terbuka, 2 terbuka.

## Pengujian

```bash
pnpm --filter @tbe/supplier-service test
```

97 test, cakupan 95%. Seluruh perilaku berbasis waktu — jendela pemutus, backoff, pemulihan bertahap — diuji dengan jam yang dikendalikan, bukan dengan menunggu. Pengujian yang benar-benar menunggu tiga puluh detik adalah pengujian yang akan dimatikan orang, dan pemulihan bertahap justru bagian yang paling sering salah.

**Belum diverifikasi:** Redis dan Kafka belum pernah menyala bersama service ini. Keadaan pemutus yang dibagikan dibuktikan lewat penyimpanan dalam memori yang dipakai bersama dua instance — memakai fungsi transisi yang sama persis dengan implementasi Redis — tetapi skrip Lua-nya sendiri belum pernah dijalankan. Lihat [docs/plan/step-11-supplier-service.md](../../docs/plan/step-11-supplier-service.md).
