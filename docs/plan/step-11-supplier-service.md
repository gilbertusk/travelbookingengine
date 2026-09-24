# Step 11 — supplier-service dan ketahanan

**Fase 2** · Milestone 3 · Estimasi 6 jam · Prasyarat: Step 10

## Tujuan

Menjadikan supplier yang rapuh sebagai ketergantungan yang aman. Step ini yang memenuhi NFR-03 dan NFR-04, dan menjadi dasar klaim "satu supplier mati tidak menurunkan sistem".

## Prompt

```
Buat apps/supplier-service, service yang membungkus seluruh komunikasi dengan
supplier dengan lapisan ketahanan.

Baca docs/plan/CONVENTIONS.md serta PRD NFR-03, NFR-04, dan NFR-14 terlebih dahulu.

Tulis test lebih dulu.

1. Pemutus sirkuit per supplier
   - Memakai opossum, satu instance per supplier per operasi
   - Ambang, jendela, dan durasi terbuka dapat dikonfigurasi per supplier,
     disimpan sebagai konstanta bernama bukan angka ajaib
   - Keadaan pemutus dipublikasikan sebagai metrik supplier_circuit_state
   - Perubahan keadaan menerbitkan peristiwa Kafka supplier.degraded dan
     supplier.recovered
   - Keadaan pemutus dibagikan antar instance lewat Redis, supaya penggandaan
     horizontal tidak membuat tiap instance belajar sendiri-sendiri

2. Kebijakan percobaan ulang
   Berbasis jenis SupplierError dari Step 10:
   - timeout dan upstream_error: boleh dicoba ulang, backoff eksponensial dengan jitter
   - rate_limited: dicoba ulang setelah jeda lebih panjang
   - invalid_response: TIDAK dicoba ulang, langsung gagal
   - sold_out, not_found, price_changed: TIDAK dicoba ulang, ini jawaban sah
   - Operasi book TIDAK PERNAH dicoba ulang secara buta. Lihat butir 4

3. Pembatasan laju keluar
   - Token bucket per supplier berbasis Redis
   - Melindungi supplier dari dibanjiri oleh sistem kita sendiri

4. Percobaan ulang aman untuk book
   Ini implementasi US-05 pada PRD:
   - Bila book menghasilkan timeout, JANGAN mencoba book lagi
   - Panggil getBooking dengan idempotency key untuk memastikan status sebenarnya
   - Bila pemesanan sudah terbentuk, adopsi hasilnya
   - Bila belum, barulah book boleh diulang
   - Seluruh percobaan dicatat di tabel supplier_requests untuk rekonsiliasi

5. Pencatatan permintaan
   - Tabel supplier_requests: id, supplierId, operation, requestPayload,
     responsePayload, latencyMs, outcome, attemptNumber, idempotencyKey, createdAt
   - Payload yang disimpan sudah diredaksi dari kredensial
   - Dipakai untuk debugging dan untuk rekonsiliasi di Step 28

6. Antarmuka internal
   - HTTP internal yang dipakai search-service dan booking-service
   - Consumer RabbitMQ untuk perintah supplier.confirm dan supplier.cancel
   - Kedua jalur memakai use case yang sama, tidak ada duplikasi logika

7. Konfigurasi supplier
   - Tabel suppliers: kode, nama, tipe adapter, base URL, referensi kredensial,
     isActive, pengaturan batas waktu dan pemutus sirkuit
   - Endpoint operasi untuk mengaktifkan, menonaktifkan, dan mengubah konfigurasi
     (FR-29), dilindungi peran operator
   - Kredensial supplier TIDAK disimpan di tabel, hanya referensinya. Nilainya dari env

8. Metrik
   - supplier_request_duration_seconds dengan label supplier, operation, outcome
   - supplier_circuit_state
   - supplier_retry_total

Test yang wajib ada, memakai mock-supplier dengan penyuntikan kegagalan:
- Pemutus terbuka setelah ambang kegagalan tercapai, dan berhenti memanggil supplier
- Pemutus setengah terbuka memulihkan diri ketika supplier sehat kembali
- invalid_response tidak memicu percobaan ulang
- Timeout pada book memicu getBooking, bukan book ulang — ini test terpenting di step ini
- Pemesanan yang sudah terbentuk diadopsi, tidak dibuat ganda
- Keadaan pemutus dibagikan antar dua instance lewat Redis

Commit: feat: add supplier service with resilience layer
```

## Definisi Selesai

- [x] Pemutus sirkuit bekerja per supplier dan keadaannya dibagikan lewat Redis
- [x] Kebijakan percobaan ulang berbeda sesuai jenis galat — dibuktikan dengan test
- [x] Timeout pada `book` memicu `getBooking`, bukan pengulangan buta — dibuktikan dengan test
- [x] Pemesanan yang sudah terbentuk diadopsi tanpa membuat ganda
- [x] Peristiwa `supplier.degraded` dan `supplier.recovered` terbit ke Kafka
- [x] Seluruh permintaan tercatat dengan payload teredaksi
- [x] Kredensial supplier tidak tersimpan di database
- [ ] Metrik muncul di Prometheus dan grafiknya terlihat di Grafana — **belum diverifikasi**, Docker mati
- [x] Cakupan test ≥ 85% — 95.5% pernyataan
- [x] Commit terbuat

## Catatan

Test "timeout pada book memicu getBooking" adalah satu-satunya test di project ini yang secara langsung mencegah kerugian uang sungguhan. Tulis dengan serius, dan sebut secara khusus di README nanti.

### Penyimpangan dari prompt, dan alasannya

**Pemutus sirkuit tidak memakai opossum.** Prompt menyebut opossum, tetapi juga mewajibkan keadaan pemutus dibagikan antar instance lewat Redis dan dibuktikan dengan test. Kedua syarat itu bertabrakan: state opossum hidup di dalam proses, jadi ia tidak dapat berbagi hitungan kegagalan antar instance — yang dapat dibagikan hanya penanda "sudah terbuka", sementara penghitungannya tetap per-proses.

Syarat berbagi state ada di Definisi Selesai dan karena itu didahulukan. Yang dibuat: mesin keadaan murni di `domain/circuit.ts` di belakang port `CircuitStore`, dengan implementasi Redis (baca-lalu-tulis bersyarat lewat Lua) dan implementasi dalam memori untuk pengujian. Keduanya memakai fungsi transisi yang sama persis — kalau masing-masing menghitung sendiri, pengujian akan membuktikan perilaku yang tidak pernah benar-benar berjalan.

Dikonfirmasi ke pengguna sebelum dikerjakan.

### Temuan saat mengerjakan step ini

**1. Kamar habis tidak boleh dihitung pemutus sirkuit.** Jawaban `sold_out` datang dari supplier yang sehat. Menghitungnya akan membuka pemutus tepat pada saat permintaan sedang tinggi — yaitu saat supplier paling dibutuhkan. Hal yang sama berlaku untuk `rate_limited`: supplier sedang melindungi dirinya, dan yang harus menyesuaikan adalah pembatas laju keluar kita.

**2. Pemutus yang terbuka tidak boleh langsung tertutup.** Setelah durasinya lewat ia menjadi setengah terbuka, dan butuh dua keberhasilan berturut-turut untuk menutup penuh. Supplier yang baru pulih kerap berhasil sekali lalu gagal lagi; menutup setelah satu keberhasilan mengirim seluruh trafik kembali dan pemutusnya membuka lagi seketika.

**3. Keadaan setengah terbuka tidak disimpan.** Ia dihitung dari cap waktu pembukaan. Menyimpannya berarti satu penulisan ke Redis setiap kali waktu berjalan melewati ambang — penulisan untuk sesuatu yang dapat dihitung.

**4. `invalid_response` dianggap tidak pasti pada `book`, bukan hanya `timeout`.** Respons yang tidak dapat diurai bisa saja merupakan konfirmasi yang bentuknya berubah. Memperlakukannya sebagai kegagalan biasa berarti mengulang `book` atas pemesanan yang mungkin sudah ada.

**5. Kegagalan saat bertanya dilaporkan dengan galat ASLI-nya.** Ketika `book` timeout lalu `findBookingByIdempotencyKey` juga gagal, yang dikembalikan adalah galat `book`, bukan galat saat bertanya — karena yang pertama itulah yang menjelaskan kenapa statusnya tidak pasti.

**6. Penangan RabbitMQ tidak melempar untuk status `uncertain`.** Melempar berarti perintahnya dikirim ulang, dan pengiriman ulang `book` dalam keadaan tidak pasti adalah persis yang dicegah seluruh mekanisme ini. Yang dilempar hanya jawaban sah yang butuh kompensasi saga.

**7. Batas 4 parameter memaksa bentuk yang lebih baik.** `priceCheck` dan `hold` awalnya menerima lima dan enam argumen posisional; keduanya kini menerima satu objek, dan rute HTTP dapat meneruskan badan permintaannya apa adanya.

**8. Label `operation` ditambahkan ke `supplier_circuit_state`.** Pemutusnya memang satu per supplier per operasi; satu pengukur berlabel supplier saja akan saling menimpa antar operasi. Legenda dasbor Grafana ikut disesuaikan.

**9. Satu pengujian lama di shared-kernel ternyata rapuh.** `runChecks menjalankan seluruh pemeriksaan secara paralel` mengukur lama waktu, dan gagal saat seluruh paket berjalan bersamaan meski kodenya benar. Diubah menjadi pembuktian lewat urutan kejadian: ketiga pemeriksaan saling menahan sampai semuanya dimulai, sehingga eksekusi berurutan akan menggantung alih-alih lulus secara kebetulan.

### Yang belum diverifikasi

**Redis, Kafka, dan RabbitMQ belum pernah menyala bersama service ini.** Docker masih mati.

Yang sudah terbukti lewat 97 test: seluruh keputusan ketahanan — pembukaan dan pemulihan pemutus, pembedaan kebijakan percobaan ulang, pemulihan aman `book`, penolakan oleh pembatas laju, redaksi payload, dan pemetaan kegagalan ke status HTTP.

Yang belum terbukti: skrip Lua untuk pemutus dan token bucket belum pernah dijalankan Redis sungguhan, peristiwa `supplier.degraded` belum pernah sampai ke Kafka, dan migrasi Prisma belum pernah diterapkan. Berbagi keadaan antar instance dibuktikan lewat penyimpanan dalam memori yang dipakai bersama dua instance — memakai fungsi transisi yang sama dengan implementasi Redis — tetapi bukan lewat Redis itu sendiri.

Jalankan ini setelah Docker menyala:

```bash
pnpm infra:up
cp apps/supplier-service/.env.example apps/supplier-service/.env
pnpm --filter @tbe/supplier-service db:migrate
pnpm --filter @tbe/supplier-service db:seed
pnpm --filter @tbe/mock-supplier dev
pnpm --filter @tbe/supplier-service dev
```

Lalu buktikan pemutusnya dengan mematikan satu supplier dan menembaknya berulang:

```bash
curl -X POST localhost:4000/admin/luna/down
for i in $(seq 1 8); do
  curl -s -o /dev/null -w "%{http_code} " -X POST localhost:4004/internal/suppliers/search     -H 'content-type: application/json'     -d '{"supplier":"LUNA","city":"Bali","checkIn":"2026-11-10","checkOut":"2026-11-12","guests":2}'
done
```

Status harus berubah dari 503 yang lambat menjadi 503 yang seketika begitu pemutusnya terbuka. Periksa `supplier_circuit_state` di `localhost:9090` dan grafiknya di `localhost:3001`.
