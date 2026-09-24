# Step 12b — Katalog properti dan pemetaan supplier

**Fase 2** · Milestone 3 · Estimasi 5 jam · Prasyarat: Step 12 · Konsekuensi keputusan Q5

## Tujuan

Menyediakan identitas properti yang stabil, milik sistem kita sendiri, supaya deduplikasi menjadi pencarian di tabel dan bukan tebakan saat berjalan. Ini yang membuat FR-04, FR-08, dan rendering sisi server untuk SEO mungkin dilakukan.

Batas yang tidak boleh dilanggar: katalog menyimpan **data statis saja**. Harga dan ketersediaan tidak pernah masuk ke sini.

## Prompt

```
Bangun katalog properti dan pemetaan supplier di dalam apps/search-service.

Baca terlebih dahulu:
- PRD Bab 14 Q5 yang sudah terjawab, Bab 8 glosarium, FR-04, FR-08, Bab 12
- docs/plan/CONVENTIONS.md

Keputusan yang sudah diambil dan tidak perlu dipertimbangkan ulang:
- Katalog dimiliki search-service, bukan service tersendiri. Search adalah
  satu-satunya konsumennya, dan memisahkannya hanya menambah lompatan jaringan
  di jalur kritis
- Katalog menyimpan data statis saja. Harga dan ketersediaan TIDAK PERNAH
  disimpan. Pelanggaran aturan ini merusak premis dasar sistem

Tulis test lebih dulu.

1. Skema
   - properties: id, slug unik, name, normalizedName, address, city, countryCode,
     latitude, longitude, timezone, starRating, amenities, description,
     photos, createdAt, updatedAt
     Kolom timezone penting — dipakai Step 25 untuk menghitung tenggat pembatalan
   - supplier_property_mappings: id, supplierId, supplierPropertyId,
     propertyId, confidence, mappedAt, mappedBy
     Batasan unik pada (supplierId, supplierPropertyId)
   - unmapped_properties: id, supplierId, supplierPropertyId, rawName,
     rawAddress, latitude, longitude, firstSeenAt, lastSeenAt, occurrences
   - Indeks: slug, city, dan indeks GIN untuk full-text pada name dan city

   Tidak ada satu pun kolom harga atau ketersediaan di ketiga tabel ini.

2. Pengisian katalog
   - Skrip seed yang membaca data dari mock-supplier dan membangun katalog
     beserta pemetaannya
   - Karena mock-supplier memakai seed tetap dan kamu mengendalikan properti
     mana muncul di supplier mana, kebenaran dasarnya sudah kamu pegang.
     Manfaatkan itu: bangun pemetaan dari data seed, bukan dari tebakan
   - Skrip idempoten, dapat dijalankan berulang

3. Pemetaan saat berjalan
   - Fungsi resolveProperty(supplierId, supplierPropertyId) yang mengembalikan
     propertyId internal atau menandai belum terpetakan
   - Pemetaan dimuat ke Redis sebagai tabel pencarian saat startup dan
     disegarkan berkala. Jalur pencarian TIDAK boleh menyentuh database,
     sesuai ketentuan performa di Step 13
   - Perubahan pemetaan membatalkan cache terkait

4. Properti belum terpetakan
   - Dicatat ke unmapped_properties dengan penghitung kemunculan
   - Tetap ditampilkan di hasil pencarian apa adanya, memakai data mentah
     dari supplier, ditandai, dan tanpa URL stabil
   - Jangan disembunyikan. Menyembunyikan berarti kehilangan inventaris,
     dan itu perilaku yang salah untuk sebuah agregator
   - Sediakan endpoint operator untuk melihat antrian ini dan memetakan
     secara manual ke properti yang sudah ada, atau membuat properti baru

5. Pencarian katalog (FR-08)
   - Endpoint autocomplete untuk kota dan nama properti
   - Memakai full-text PostgreSQL, bukan Elasticsearch. Katalog ini kecil
     dan jarang berubah — lihat PRD Bab 12
   - Hasil di-cache di Redis dengan TTL

6. Identitas untuk URL
   - Slug dibangkitkan dari nama dan kota, dijamin unik
   - Slug bersifat permanen. Perubahan nama properti tidak mengubah slug,
     karena URL yang sudah terindeks tidak boleh rusak

Test yang wajib:
- resolveProperty mengembalikan properti internal yang sama untuk pengenal
  supplier berbeda yang menunjuk properti yang sama
- Properti belum terpetakan dicatat dan penghitungnya bertambah
- Properti belum terpetakan tetap muncul di hasil, ditandai, tanpa slug
- Slug unik dan tidak berubah meski nama properti diperbarui
- Autocomplete mengembalikan hasil yang relevan
- Pemetaan dibaca dari Redis, bukan database, pada jalur pencarian
- Skrip seed idempoten

Terakhir, tulis ADR di docs/adr/ berisi keputusan Q5: konteks, keputusan,
alternatif pass-through murni yang ditolak beserta alasannya, dan konsekuensinya.
Tekankan pembedaan antara katalog (data statis, milik kita) dan inventaris
(harga dan ketersediaan, milik supplier) — pembedaan ini yang menjaga premis
dasar project tetap utuh.

Commit: feat: add property catalog and supplier mapping
```

## Definisi Selesai

- [x] Tidak ada kolom harga atau ketersediaan di seluruh tabel katalog — ditegakkan `pnpm verify:catalog`
- [x] Pemetaan dibangun dari data seed mock-supplier dan skripnya idempoten
- [x] `resolveProperty` menyatukan pengenal supplier berbeda ke satu properti internal
- [x] Pemetaan dibaca dari Redis pada jalur pencarian, bukan dari basis data — dibuktikan dengan menghitung pembacaan
- [x] Properti belum terpetakan tetap ditampilkan, ditandai, dan masuk antrian
- [x] Operator dapat memetakan manual dari antrian — ke properti yang ada, atau dengan membuat properti baru
- [x] Slug unik, permanen, dan tidak berubah saat nama diperbarui
- [x] Kolom `timezone` terisi dan wajib — dibutuhkan Step 25
- [x] Autocomplete memakai full-text PostgreSQL
- [x] ADR keputusan Q5 ditulis, memuat alternatif yang ditolak — ADR-0001 dilengkapi, bukan ADR baru
- [ ] Indeks GIN, kueri full-text, dan seed berjalan terhadap Postgres sungguhan — **belum diverifikasi**, Docker mati
- [x] Cakupan test ≥ 85% — 99,5% pernyataan
- [x] Commit terbuat

## Catatan

Kolom `timezone` tidak hanya terisi, tetapi **wajib** pada jalur pembuatan properti manual. Bawaan `Asia/Jakarta` akan benar untuk sebagian besar properti dan salah diam-diam untuk Bali dan luar negeri — dan salah diam-diam adalah bentuk kesalahan yang paling mahal di sini, karena baru terlihat di Step 25 sebagai pengembalian dana yang keliru.

### Penyimpangan dari prompt, dan alasannya

**ADR-0001 dilengkapi, bukan ditulis ulang sebagai ADR baru.** Prompt meminta ADR berisi keputusan Q5; ADR itu sudah ditulis pada Step 10, ketika keputusannya dibutuhkan lebih dulu oleh lapisan adapter. Yang ditambahkan sekarang adalah bagian yang khusus diminta prompt ini dan memang belum ada: alternatif **pass-through murni** yang ditolak beserta tiga akibatnya, tabel pembedaan katalog dan inventaris, dan alasan praktis kepemilikan katalog oleh search-service. Dua ADR untuk satu pertanyaan akan membuat pembaca berikutnya harus menebak mana yang berlaku.

**Endpoint baru di mock-supplier: `GET /admin/catalog`.** Prompt mewajibkan seed membangun pemetaan dari data seed, bukan dari tebakan — dan itu mengharuskan kebenaran dasarnya dapat dibaca. Endpoint ini menerbitkan properti kanonik beserta supplier yang menjualnya, sesuatu yang tidak pernah diterbitkan supplier sungguhan. Ia berada di bawah `/admin` supaya batasnya terlihat dari URL, dan tidak satu pun kode jalur pencarian memanggilnya.

### Temuan saat mengerjakan step ini

**1. Redis saja tidak cukup untuk memenuhi syarat performanya.** Prompt mewajibkan pemetaan dimuat ke Redis dan jalur pencarian tidak menyentuh basis data. Tetapi pencarian memanggil pemetaan ratusan kali per permintaan; kalau setiap panggilan menembak Redis, yang dihemat hanyalah beban Postgres sementara perjalanan jaringannya tetap ratusan kali. Yang dibuat: tiga lapis — Postgres sebagai sumber, Redis sebagai salinan bersama antar instance, dan snapshot di memori sebagai yang benar-benar dibaca. Port `CatalogSnapshot` dibuat **sinkron**, sehingga bentuk tipenya sendiri menutup kemungkinan memanggil jaringan dari dalamnya.

**2. Pencatatan properti belum terpetakan adalah penulisan basis data di jalur pencarian.** Itu melanggar syarat yang sama. Diselesaikan dengan penyangga di memori yang menggabungkan kemunculan berulang lebih dulu — satu pencarian dapat memunculkan properti yang sama dari lima supplier — lalu disiram berkala. Permintaan pencarian tidak pernah menunggu satu pun penulisan.

**3. Kemunculan yang gagal ditulis TIDAK dikembalikan ke penyangga.** Penyangga yang tumbuh karena basis data sedang tumbang akan menghabiskan memori proses. Penghitung kemunculan yang meleset jauh lebih murah daripada service pencarian yang mati.

**4. Properti belum terpetakan dimodelkan sebagai varian union, bukan sebagai properti dengan slug opsional.** Slug opsional akan menggoda pemanggil menuliskan `property.slug ?? property.id`, yang menghasilkan URL yang berubah begitu pemetaannya ada. Varian `unmapped` tidak punya bidang slug sama sekali.

**5. Slug permanen harus ditegakkan di dua tempat, bukan satu.** `buildSeedPlan` memakai slug lama untuk properti yang sudah ada, dan `upsertMany` mengeluarkan kolom `slug` dari bagian `update`-nya. Menegakkannya hanya di seed akan runtuh begitu ada jalur penulisan kedua.

**6. Autocomplete membutuhkan DUA indeks, bukan satu.** `to_tsvector` mencocokkan kata utuh; autocomplete harus menjawab sejak huruf ketiga, dan pada huruf ketiga belum ada satu pun kata utuh untuk dicocokkan. Ditambahkan indeks trigram untuk pencocokan awalan. Konfigurasi `simple` dipakai, bukan `english` — stemming Inggris atas "Padma" atau "Kirana" hanya merusak pencocokan.

**7. Kota disimpulkan dari properti yang cocok, bukan dari tabel kota tersendiri.** Kota tanpa satu pun properti tidak berguna sebagai saran: pengguna yang memilihnya mendapat hasil kosong. Menurunkannya dari properti membuat keadaan itu mustahil.

**8. Migrasi awal dapat dibangkitkan tanpa basis data.** `prisma migrate diff --from-empty --to-schema` bekerja luring, jadi SQL-nya ada dan dapat dibaca sekarang meski Docker mati. Indeks GIN ditambahkan tangan di berkas yang sama — Prisma tidak dapat menyatakan indeks atas ekspresi `tsvector`.

**9. `verify-money.mjs` dari Step 12 melarang SELURUH kolom `Float`, termasuk koordinat.** Koordinat geografis adalah pecahan sungguhan: tidak ada satuan terkecil yang masuk akal, tidak ada yang direkonsiliasi dengannya, dan presisi lima desimal sudah setara sekitar satu meter. Larangannya tetap menyeluruh — yang ditambahkan adalah daftar pengecualian bernama, sehingga setiap pengecualian menjadi keputusan yang tertulis alih-alih celah dalam pola.

**10. Dua fungsi mati ditemukan lewat cakupan.** `groupBySupplierRefs` di domain dan `loadSnapshot` di application — keduanya ditulis lalu tidak pernah dipakai karena pemanggilnya menyelesaikannya sendiri. Dihapus.

**11. `verify-catalog.mjs` menolak berjalan bila model katalog berganti nama.** Skrip yang memeriksa model yang tidak ada lagi akan lulus karena buta, bukan karena bersih — dan skrip verifikasi yang lulus karena buta lebih berbahaya daripada tidak ada skrip sama sekali.

### Yang belum diverifikasi

**Postgres belum pernah menyala bersama service ini.** Docker masih mati.

Yang sudah terbukti lewat 118 test: seluruh keputusan katalog — penyatuan pengenal supplier, keabadian slug, idempotensi rencana seed, penolakan skema, penampilan properti belum terpetakan, penghitung kemunculan, pemetaan manual kedua jalur, batas hasil autocomplete, perilaku cache, dan ketiga keadaan pemuatan snapshot. Ditambah 8 test di mock-supplier yang menjaga kebenaran dasarnya tetap konsisten.

Yang belum terbukti: migrasi belum pernah diterapkan, indeks GIN dan trigram belum pernah dibuat, kueri full-text `plainto_tsquery` belum pernah dijalankan Postgres sungguhan, dan seed belum pernah menulis satu baris pun. Penyimpanan Prisma dan Redis sengaja dikecualikan dari cakupan — mengujinya dengan tiruan hanya menguji tiruannya. Keduanya diuji pada Step 20.

Jalankan ini setelah Docker menyala:

```bash
pnpm infra:up
cp apps/search-service/.env.example apps/search-service/.env
pnpm --filter @tbe/search-service db:migrate
pnpm --filter @tbe/mock-supplier dev
pnpm --filter @tbe/search-service db:seed
pnpm --filter @tbe/search-service dev
```

Lalu buktikan ketiga hal yang belum terbukti:

```bash
curl -s localhost:4006/health/ready
curl -s "localhost:4006/catalog/suggest?q=pad"
curl -s localhost:4006/catalog/properties/padma-bali-boutique-hotel
```

Kesiapan bernilai `true` berarti katalognya termuat. Saran untuk `pad` — tiga huruf, belum satu kata utuh — hanya dapat dijawab indeks trigram; jawaban kosong berarti indeksnya tidak terbuat.

Lalu jalankan seed dua kali dan bandingkan:

```bash
pnpm --filter @tbe/search-service db:seed
pnpm --filter @tbe/search-service db:seed
```

Pemanggilan kedua harus melaporkan jumlah "properti sudah ada" sama dengan jumlah propertinya, dan tidak satu pun slug berubah. Angka "sudah ada" nol pada pemanggilan kedua berarti penanda sumber seed tidak tersimpan, dan slug akan dibangkitkan ulang setiap kali — persis kegagalan yang dicegah seluruh mekanisme ini.
