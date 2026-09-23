# Step 10 — Package supplier-adapters

**Fase 2** · Milestone 3 · Estimasi 6 jam · Prasyarat: Step 09 · Q5 sudah dijawab

## Tujuan

Menerjemahkan lima antarmuka supplier yang berbeda menjadi satu model kanonik. Di sinilah heterogenitas supplier — masalah teknis nomor 5 di PRD — benar-benar ditangani.

## Prompt

```
Buat packages/supplier-adapters, lapisan yang menerjemahkan antarmuka lima supplier
yang berbeda-beda menjadi satu model kanonik internal.

Baca terlebih dahulu:
- docs/plan/CONVENTIONS.md
- PRD Bab 8 (glosarium) — penamaan model kanonik WAJIB mengikuti glosarium
- apps/mock-supplier/README.md — bentuk asli tiap supplier

Tulis test lebih dulu. Setiap adapter diuji terhadap contoh respons sungguhan
dari mock-supplier, disimpan sebagai fixture.

1. Model kanonik
   Definisikan dengan Zod, bukan hanya tipe TypeScript, karena data ini berasal
   dari sumber tidak tepercaya:
   - Property, RoomType, RatePlan, Availability, CancellationPolicy
   - HoldResult, BookingResult, PriceCheckResult
   - Seluruh nilai uang memakai tipe dari packages/money (dibuat di Step 12 —
     untuk sekarang definisikan antarmuka minimalnya dan tandai untuk diganti)

2. Port SupplierGateway
   Satu interface yang harus diimplementasi setiap adapter:
   - search(criteria): Promise<Result<SupplierSearchResult, SupplierError>>
   - priceCheck(ratePlanRef): Promise<Result<PriceCheckResult, SupplierError>>
   - hold(ratePlanRef, guests): Promise<Result<HoldResult, SupplierError>>
   - book(holdRef, guest, idempotencyKey): Promise<Result<BookingResult, SupplierError>>
   - cancel(bookingRef): Promise<Result<void, SupplierError>>
   - getBooking(bookingRef): Promise<Result<BookingResult, SupplierError>>

   SupplierError adalah union diskriminan, bukan satu kelas:
   timeout, unavailable, rate_limited, invalid_response, not_found,
   sold_out, price_changed, upstream_error

   Pembedaan ini menentukan perilaku di Step 11: hanya sebagian yang layak
   dicoba ulang.

3. Lima adapter
   - SkyAdapter, NovaAdapter, OrbitAdapter, LunaAdapter, ZephAdapter
   - Setiap adapter menangani perbedaan protokol, penamaan field, format tanggal,
     dan mata uangnya sendiri
   - OrbitAdapter mem-parse XML dengan fast-xml-parser
   - Adapter yang sumbernya USD menandai mata uang dengan benar. Adapter TIDAK
     melakukan konversi mata uang — itu tanggung jawab pricing-service
   - Setiap respons supplier divalidasi terhadap skema sebelum dinormalisasi.
     Respons cacat menghasilkan invalid_response, bukan lemparan mentah

4. Klien HTTP
   - Berbasis undici
   - Batas waktu per operasi, dapat dikonfigurasi per supplier
   - Operasi search punya batas waktu lebih ketat daripada book, karena
     pengguna menunggu pada search tapi tidak pada konfirmasi asinkron
   - Membawa idempotency key pada operasi book

5. Identitas properti lintas supplier
   Keputusan Q5 sudah diambil: ada katalog internal dengan tabel pemetaan,
   dibangun di Step 12b. Karena itu adapter TIDAK melakukan pencocokan apa pun.

   - Adapter mengembalikan pengenal properti dari supplier apa adanya,
     beserta nama, koordinat, dan alamat mentah sebagai data pendukung
   - Pemetaan ke pengenal properti internal bukan tanggung jawab lapisan ini
   - Data pendukung tetap disertakan karena dipakai Step 12b untuk membangun
     pemetaan dan untuk menangani properti yang belum terpetakan

6. Registri adapter
   - Pabrik yang mengembalikan adapter berdasarkan kode supplier
   - Konfigurasi per supplier dibaca dari luar, bukan tertanam

Ketentuan:
- Package ini murni penerjemahan. Tidak ada pemutus sirkuit, tidak ada retry,
  tidak ada cache — semuanya milik Step 11
- Tidak ada ketergantungan pada Express, Kafka, atau RabbitMQ

Test yang wajib ada:
- Setiap adapter menormalisasi fixture-nya ke bentuk kanonik yang benar
- Respons cacat menghasilkan invalid_response, bukan lemparan
- Batas waktu menghasilkan timeout
- Respons XML Orbit ter-parse benar
- Mata uang ditandai benar dan tidak dikonversi

Commit: feat: add supplier adapters package
```

## Definisi Selesai

- [ ] Lima adapter mengimplementasi port yang sama
- [ ] Seluruh respons supplier divalidasi sebelum dinormalisasi
- [ ] `SupplierError` berupa union diskriminan yang membedakan jenis kegagalan
- [ ] Adapter XML bekerja terhadap fixture sungguhan dari mock-supplier
- [ ] Mata uang ditandai, tidak dikonversi di lapisan ini
- [ ] Tidak ada logika ketahanan di package ini
- [ ] Keputusan Q5 tercatat sebagai ADR
- [ ] Cakupan test ≥ 85%
- [ ] Commit terbuat

## Catatan

Membedakan jenis kegagalan terlihat berlebihan sekarang, tetapi Step 11 dan Step 19 sepenuhnya bergantung padanya. Mencoba ulang `sold_out` adalah pemborosan; mencoba ulang `timeout` tanpa memeriksa status dulu adalah penyebab pemesanan ganda.
