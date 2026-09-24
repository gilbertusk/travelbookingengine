# Step 13 — search-service: fan-out dan cache

**Fase 2** · Milestone 3 · Estimasi 8 jam · Prasyarat: Step 12b

## Tujuan

Jantung produk. Step ini menjawab masalah teknis nomor 1 dan 2 di PRD sekaligus: latensi tidak seragam dan cache yang basi. Metrik M1, M2, dan M3 ditentukan di sini.

## Prompt

```
Buat apps/search-service, orkestrator pencarian teragregasi.

Baca terlebih dahulu:
- docs/plan/CONVENTIONS.md
- PRD Bab 2.2 masalah 1 dan 2, FR-01 sampai FR-05, US-01, NFR-01, NFR-03

Tulis test lebih dulu.

1. Fan-out dengan batas waktu anggaran
   - Panggil seluruh supplier aktif secara paralel lewat supplier-service
   - Anggaran waktu total dikonfigurasi lewat konstanta bernama, mulai dari 1200ms
   - Gunakan pola allSettled: satu supplier gagal tidak membatalkan yang lain
   - Setelah anggaran habis, kembalikan hasil dari supplier yang sudah menjawab
   - Supplier yang melewati anggaran TIDAK dibatalkan. Biarkan selesai di latar
     belakang dan simpan hasilnya ke cache untuk pencarian berikutnya.
     Ini implementasi butir terakhir US-01
   - Supplier dengan pemutus sirkuit terbuka dilewati tanpa dipanggil

2. Cache berlapis
   Lapis 1 — cache hasil gabungan:
   - Kunci dari hash kriteria pencarian ternormalisasi: kota, rentang tanggal,
     jumlah tamu. Normalisasi penting supaya kriteria setara menghasilkan kunci sama
   - TTL pendek, mulai dari 5 menit
   - Menyimpan juga daftar supplier yang berkontribusi

   Lapis 2 — cache per supplier:
   - Kunci dari supplier ditambah kriteria
   - TTL sedikit lebih panjang
   - Inilah yang membuat hasil supplier lambat tetap berguna pada pencarian
     berikutnya, dan yang membuat pemulihan satu supplier tidak membatalkan
     seluruh cache

   Aturan:
   - Cache stampede dicegah dengan penguncian singkat per kunci
   - Metrik search_cache_hits_total dan search_cache_misses_total dicatat
     per lapisan
   - Sediakan cara membatalkan cache per kota, untuk keperluan operasi

3. Penggabungan dan deduplikasi
   - Gabungkan rate plan dari seluruh supplier
   - Deduplikasi lewat tabel pemetaan dari Step 12b, dibaca dari cache Redis
     bukan dari database, supaya jalur kritis tetap bebas query
   - Properti yang sama dari beberapa supplier menjadi satu entri dengan harga
     terendah, tetapi seluruh tawaran tetap tersimpan untuk halaman detail
   - Properti yang belum terpetakan tetap ditampilkan apa adanya, ditandai,
     tanpa URL stabil, dan dicatat ke antrian pemetaan. Jangan disembunyikan —
     menyembunyikannya berarti kehilangan inventaris
   - Urutkan sesuai permintaan: harga, peringkat, atau relevansi
   - Terapkan penyaringan yang diminta

4. Penetapan harga
   - Seluruh hasil dilewatkan ke pricing-service dalam SATU panggilan,
     bukan per rate plan
   - Harga yang dikembalikan ke klien adalah harga akhir, tidak pernah harga supplier

5. Hasil parsial
   - Respons memuat metadata: daftar supplier yang menjawab, yang melewati
     batas waktu, dan yang sedang tidak tersedia
   - Klien memakai ini untuk PartialResultNotice sesuai DESIGN-SYSTEM.md
   - Respons dari cache menandai dirinya sebagai berasal dari cache beserta umurnya

6. Peristiwa
   - Terbitkan search.performed ke Kafka dengan kriteria, jumlah hasil,
     latensi, dan sumber (cache atau langsung). Jangan memuat data pribadi

7. Endpoint
   - GET /search dengan validasi kriteria yang ketat:
     tanggal keluar harus setelah tanggal masuk, rentang maksimum wajar,
     tidak boleh tanggal lampau, jumlah tamu dalam batas
   - GET /search/:propertyId untuk detail seluruh tawaran satu properti (FR-10)

8. Performa
   - Seluruh jalur kritis bebas dari operasi berurutan yang bisa diparalelkan
   - Tidak ada query database di jalur pencarian selain yang ter-cache

Test yang wajib, memakai mock-supplier dengan penyuntikan kegagalan:
- Satu supplier lambat 3 detik: hasil tetap kembali dalam anggaran waktu
- Satu supplier mati: hasil tetap kembali, metadata menandainya
- Hasil supplier lambat masuk cache dan muncul pada pencarian berikutnya
- Kriteria setara menghasilkan kunci cache yang sama
- Cache stampede: seratus permintaan serentak untuk kunci sama hanya memicu
  satu kali fan-out
- Deduplikasi menggabungkan properti sama dari supplier berbeda
- Harga yang dikembalikan selalu harga akhir

Commit: feat: add search service with fan-out and layered cache
```

## Definisi Selesai

- [x] Satu supplier lambat tidak membuat pencarian melewati anggaran waktu
- [x] Supplier mati dilewati tanpa penundaan karena pemutus sirkuit — dilewati tanpa dipanggil sama sekali
- [x] Hasil supplier lambat tetap masuk cache dan berguna pada pencarian berikutnya
- [x] Cache stampede dicegah — dibuktikan dengan test seratus permintaan serentak
- [x] Deduplikasi lintas supplier bekerja terhadap data mock-supplier
- [x] Metadata hasil parsial dikembalikan dan akurat
- [x] Penetapan harga dilakukan dalam satu panggilan untuk seluruh hasil
- [x] Peristiwa `search.performed` terbit tanpa data pribadi
- [ ] Dijalankan terhadap mock-supplier, supplier-service, dan pricing-service yang benar-benar menyala — **belum diverifikasi**, Docker mati
- [x] Cakupan test ≥ 85% — 94,7% pernyataan
- [x] Commit terbuat

## Catatan

Membiarkan supplier lambat selesai di latar belakang memang detail yang membedakan implementasi serius dari yang asal jalan — dan ternyata bukan bagian yang paling sulit. Yang paling sulit adalah membuktikannya tanpa satu milidetik pun benar-benar berlalu.

### Temuan saat mengerjakan step ini

**1. Anggaran waktu tidak dapat diuji dengan waktu.** Uji yang benar-benar menunggu 1200ms membuat suite lambat; uji yang menunggu 50ms lulus di mesin cepat dan gagal di CI yang sibuk. Keduanya menguji penjadwal sistem operasi, bukan kode ini. Yang dipakai: port `Deadline` yang dihabiskan tangan oleh pengujian, dan supplier yang menggantung sampai dilepas. Seluruh 14 uji fan-out dan 34 uji orkestrator berjalan dalam setengah detik, dan tidak satu pun memanggil `setTimeout`.

**2. Satu penangan promise, bukan dua.** Rancangan pertama memasang penangan terpisah untuk "jawaban dalam anggaran" dan "jawaban terlambat". Itu berarti jawaban yang sama dapat diproses dua kali ketika supplier menjawab tepat di batas anggaran — bug yang paling jarang terjadi dan paling sulit ditiru ulang. Digabung menjadi satu penangan yang memutuskan sendiri; keamanannya bertumpu pada satu sifat: blok yang menandai siapa kehabisan waktu berjalan tanpa satu pun `await` di dalamnya, jadi tidak ada celah bagi jawaban untuk menyelinap.

**3. Menunggu jumlah tick adalah menuliskan implementasi ke dalam uji.** Versi pertama memakai `flush()` sebanyak lima tick lalu menghabiskan anggaran. Rantai `await` di jalur pencarian ternyata lebih panjang dari itu, jadi SKY ditandai kehabisan waktu padahal sudah menjawab. Diganti `until(predicate)` yang menunggu KEADAANNYA lewat microtask dan gagal dengan pesan jelas bila keadaan itu tidak pernah datang — tidak patah setiap kali satu `await` ditambahkan.

**4. Supplier-service belum menerbitkan keadaan pemutusnya.** Syarat "supplier dengan pemutus terbuka dilewati tanpa dipanggil" tidak dapat dipenuhi tanpa itu: satu-satunya cara mengetahuinya adalah memanggil lalu ditolak. Ditambahkan bidang `circuit.state` pada `GET /internal/suppliers`, memakai `decide` — bukan pembacaan mentah — supaya pemutus yang sudah melewati durasinya dilaporkan setengah terbuka. Melaporkannya terbuka akan membuat search-service melewatinya terus dan percobaan pemulihannya tidak pernah terjadi.

**5. `z.coerce.boolean()` adalah jebakan pada query string.** `Boolean('false')` bernilai `true`, jadi `?refundableOnly=false` akan MENYALAKAN penyaringnya. Kekeliruan itu tidak menggagalkan apa pun — ia hanya menyaring hasil yang seharusnya muncul, dan yang mengeluhkannya adalah pengguna yang tidak menemukan hotelnya. Diganti enum `'true' | 'false' | '1' | '0'`, dan diuji kedua arahnya.

**6. Penyaring harga harus berjalan SETELAH penetapan harga.** Ia bekerja pada harga jual, dan harga jual belum ada sebelum pricing-service menghitungnya. Menyaring pada harga supplier akan membuang tawaran yang sebenarnya masuk anggaran pengguna, dan menyisakan yang setelah markup justru melewatinya — dua kesalahan sekaligus, ke dua arah berlawanan.

**7. Penyaring lain justru harus berjalan pada TAWARAN, bukan properti.** Properti yang satu tarifnya refundable dan satu lagi tidak harus tetap muncul ketika pengguna menyaring "hanya refundable". Yang ikut menyusut: daftar supplier-nya — metadata yang menyebut supplier yang seluruh tawarannya tersaring adalah metadata yang berbohong.

**8. Nama properti diambil dari katalog, bukan dari supplier yang menjawab lebih dulu.** Supplier menyebut hotel yang sama dengan ejaan berbeda-beda; memakai ejaan supplier membuat nama hotel berubah-ubah antar pencarian, bergantung pada siapa yang kebetulan tercepat hari itu.

**9. Pembatalan cache per kota hanya membuang lapis pertama.** Disengaja, dan diuji sebagai keputusan: pembatalan oleh operasi hampir selalu karena pandangan gabungannya yang keliru — aturan markup berubah, katalog diperbaiki — bukan karena jawaban supplier-nya salah. Ikut membuang lapis kedua berarti memaksa lima supplier menjawab ulang untuk data yang masih benar, tepat pada saat operator sedang memperbaiki sesuatu.

**10. Yang kalah mengambil kunci menjalankan pekerjaannya sendiri.** Rancangan "tunggu pemegang kunci lalu baca hasilnya" terlihat lebih hemat, tetapi mengubah kegagalan satu pemegang kunci menjadi kegagalan seratus permintaan sekaligus. Lebih boros, tidak pernah menggantung.

**11. Bertabrakan port dengan booking-service.** search-service sempat diberi PORT 4006, yang sudah dialokasikan api-gateway untuk booking-service. Diperbaiki menjadi 4003 — yang memang sudah tertulis di tabel rute api-gateway sejak Step 08, dan tidak ada yang memeriksanya sampai sekarang. Rute `/catalog` ikut ditambahkan ke tabel itu supaya autocomplete dari Step 12b benar-benar dapat dijangkau.

**12. `SupplierCode`, bukan `string`.** Kontrak `search.performed` menuntut kode supplier dari daftar tertutup, dan itu menyingkap bahwa seluruh jalur pencarian memakai `string` tanpa alasan — padahal himpunannya memang tertutup dan sudah bertipe benar sejak model kanonik. Dipersempit di seluruh port, domain, dan fan-out, dengan validasi di batas HTTP: kode yang tidak dikenal berarti supplier-service dan search-service sedang tidak sepakat, dan meneruskannya menyebar ketidaksepakatan itu sampai ke muatan Kafka.

### Yang belum diverifikasi

**Belum pernah ada satu pun supplier sungguhan yang menjawab.** Docker masih mati, dan supplier-service serta pricing-service belum pernah menyala bersama service ini.

Yang sudah terbukti lewat 258 test: seluruh keputusan orkestrasi — anggaran waktu dan pemanenan jawaban terlambat, pola allSettled, pelewatan pemutus terbuka, kedua lapis cache, pencegahan stampede pada seratus permintaan serentak, normalisasi kunci ke dua arah, deduplikasi lintas supplier, penetapan harga sekali untuk seluruh hasil, dan penolakan kriteria di batas HTTP.

Yang belum terbukti: skrip Lua kunci Redis belum pernah dijalankan Redis sungguhan, `search.performed` belum pernah sampai ke Kafka, dan `undici` belum pernah benar-benar memanggil supplier-service maupun pricing-service. Penerjemahan jawaban keduanya sudah diuji sebagai fungsi murni — yang belum diuji hanya pemanggilannya, dan itu Step 20.

Jalankan ini setelah Docker menyala:

```bash
pnpm infra:up
cp apps/search-service/.env.example apps/search-service/.env
pnpm --filter @tbe/search-service db:migrate
pnpm --filter @tbe/mock-supplier dev
pnpm --filter @tbe/search-service db:seed
pnpm --filter @tbe/supplier-service dev
pnpm --filter @tbe/pricing-service dev
pnpm --filter @tbe/search-service dev
```

Lalu buktikan keempat klaim yang belum terbukti:

```bash
curl -s "localhost:4003/search?city=Bali&checkIn=2026-11-10&checkOut=2026-11-12&guests=2"
```

Pertama, **anggaran waktu**: jawabannya harus kembali jauh di bawah 3 detik meski LUNA lambat, dan `meta.suppliersTimedOut` menyebut LUNA.

Kedua, **pemanenan jawaban terlambat**: jalankan perintah yang sama lagi setelah beberapa detik. LUNA kini harus muncul di `meta.suppliersResponded`, dan jumlah tawaran bertambah — tanpa penantian.

Ketiga, **pemutus terbuka dilewati**: matikan satu supplier lalu tembak berulang sampai pemutusnya membuka, dan periksa `meta.suppliersUnavailable` menyebutnya.

```bash
curl -X POST localhost:4000/admin/luna/down
```

Keempat, **stampede**: seratus permintaan serentak harus menghasilkan satu lonjakan `search_cache_misses_total{layer="results"}`, bukan seratus.

```bash
curl -s localhost:4003/metrics | grep search_cache
```

`meta.source` yang selalu `live` pada permintaan kedua berarti cache tidak pernah terisi — periksa Redis sebelum menyalahkan yang lain.
