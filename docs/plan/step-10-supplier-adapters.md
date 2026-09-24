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

- [x] Lima adapter mengimplementasi port yang sama
- [x] Seluruh respons supplier divalidasi sebelum dinormalisasi
- [x] `SupplierError` berupa union diskriminan yang membedakan jenis kegagalan
- [x] Adapter XML bekerja terhadap fixture sungguhan dari mock-supplier
- [x] Mata uang ditandai, tidak dikonversi di lapisan ini
- [x] Tidak ada logika ketahanan di package ini
- [x] Keputusan Q5 tercatat sebagai ADR — [ADR-0001](../adr/0001-identitas-properti-lintas-supplier.md)
- [x] Cakupan test ≥ 85% — 90.6% pernyataan, 98.6% baris
- [x] Commit terbuat

## Catatan

Membedakan jenis kegagalan terlihat berlebihan sekarang, tetapi Step 11 dan Step 19 sepenuhnya bergantung padanya. Mencoba ulang `sold_out` adalah pemborosan; mencoba ulang `timeout` tanpa memeriksa status dulu adalah penyebab pemesanan ganda.

### Penyimpangan dari prompt, dan alasannya

**`SupplierError` punya sepuluh varian, bukan delapan.** Prompt menyebutkan delapan; `hold_expired` dan `already_cancelled` ditambahkan setelah melihat kegagalan yang benar-benar dikirim mock-supplier. Keduanya datang sebagai 409, sama seperti `sold_out` dan `price_changed`.

Menggabungkannya ke `upstream_error` akan menghapus perbedaan yang justru dibutuhkan saga pada Step 19: hold yang kedaluwarsa aman diulang dari awal karena tidak ada apa pun yang tertahan, sedangkan supplier yang rusak tidak. Daftar delapan varian ditulis sebelum bentuk kegagalan mock-supplier diketahui.

### Temuan saat mengerjakan step ini

**1. Fixture ditangkap, bukan ditulis.** Ada naskah yang menembak mock-supplier yang berjalan dan menyimpan 30 respons sungguhan. Fixture buatan tangan hanya membuktikan adapter cocok dengan apa yang penulisnya bayangkan — dan yang dibayangkan tidak memuat elemen XML tunggal yang bukan larik, atau `rating` yang datang sebagai string.

**2. Uang dihitung dengan operasi string, bukan aritmetika pecahan.** `Math.round(Number('8.115') * 100)` menghasilkan 811, bukan 812. Selisih satu sen per pemesanan tidak terlihat di layar mana pun dan baru muncul sebagai angka yang tidak cocok saat rekonsiliasi.

**3. Desimal yang terlalu rinci ditolak, bukan dibulatkan.** `267.835` untuk USD tidak dapat diwakili dalam sen. Membulatkannya diam-diam berarti menagih pengguna dengan angka yang tidak pernah disebut supplier maupun ditampilkan kepadanya.

**4. Tanggal ORBIT diuji dengan tanggal di atas 12.** `10/11/2026` terbaca benar oleh parser yang terbalik sekalipun. Rangkaian uji yang seluruhnya memakai tanggal kecil akan lulus dengan parser yang salah — pengujiannya sekarang memakai 25 dan 31, dan juga menolak `31/02/2026`, yang lolos kalau tanggalnya hanya disusun sebagai string.

**5. Elemen XML tunggal tidak menjadi larik.** Satu hotel datang sebagai objek, dua hotel sebagai larik. Kode yang langsung memanggil `.map()` bekerja sempurna di lingkungan yang selalu punya banyak hasil, lalu gagal pada pencarian yang hanya menemukan satu.

**6. `parseTagValue` dimatikan pada parser XML.** Bawaannya mengubah `"0012"` menjadi `12`, dan pengenal yang kehilangan nol di depannya adalah pengenal yang tidak cocok lagi dengan milik supplier.

**7. Fault SOAP dapat datang bersama status 200.** Amplop diperiksa lebih dulu daripada status; membaca status saja meneruskan kegagalan sebagai hasil yang sah.

**8. NOVA tidak mengelompokkan rate plan ke dalam jenis kamar.** Ia mengirim `room_options` yang datar dengan nama `"Superior — Refundable with Breakfast"`. Pengelompokan dipulihkan dari pemisah itu, dan kalau pemisahnya tidak ada, pengelompokan TIDAK ditebak — pilihan menjadi jenis kamarnya sendiri. Mengarang pengelompokan dari kemiripan nama akan menggabungkan kamar yang sebenarnya berbeda.

**9. Klien HTTP tidak boleh tahu bentuk respons.** Status non-2xx dikembalikan sebagai Ok; hanya kegagalan transport yang menjadi Err. Kalau klien mulai membaca badan respons untuk memutuskan arti 409, ia berhenti menjadi klien dan menjadi adapter keenam.

**10. Batas ukuran fungsi memaksa bentuk yang lebih baik.** Kelima pabrik adapter melewati batas 50 baris karena seluruh operasi ditulis sebagai metode di dalam satu objek literal. Setelah dipisah menjadi satu fungsi per operasi, pabriknya tinggal merangkai — pola yang sama dengan router mock-supplier, dan kelimanya kini berbentuk identik.

**11. Dua helper ditulis tanpa pernah dipakai.** `required()` dan `failInvalid()` dibuat karena terlihat akan berguna, lalu tidak satu pun adapter memanggilnya. Keduanya dihapus; cakupan test yang rendah pada berkasnya adalah yang menunjukkannya.

### Yang belum diverifikasi

Adapter **belum pernah berbicara dengan mock-supplier lewat jaringan di dalam pengujian**. Fixture-nya sungguhan, dan klien HTTP diuji terhadap server `node:http` sungguhan — tetapi keduanya diuji terpisah. Rangkaian penuh adapter terhadap mock-supplier yang berjalan dikerjakan pada Step 20 bersama Testcontainers.

Yang sudah terbukti lewat 175 test: penerjemahan kelima bentuk respons, seluruh mode kegagalan, pemetaan batas waktu dan koneksi yang ditolak, serta penolakan respons cacat pada kelima supplier.

Penangkapan fixture sendiri berjalan terhadap mock-supplier yang hidup, jadi bentuk respons yang diasumsikan adapter dipastikan cocok pada saat step ini dikerjakan.
