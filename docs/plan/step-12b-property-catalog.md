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

- [ ] Tidak ada kolom harga atau ketersediaan di seluruh tabel katalog
- [ ] Pemetaan dibangun dari data seed mock-supplier dan skripnya idempoten
- [ ] `resolveProperty` menyatukan pengenal supplier berbeda ke satu properti internal
- [ ] Pemetaan dibaca dari Redis pada jalur pencarian, bukan dari database
- [ ] Properti belum terpetakan tetap ditampilkan, ditandai, dan masuk antrian
- [ ] Operator dapat memetakan manual dari antrian
- [ ] Slug unik, permanen, dan tidak berubah saat nama diperbarui
- [ ] Kolom `timezone` terisi — dibutuhkan Step 25
- [ ] Autocomplete memakai full-text PostgreSQL
- [ ] ADR keputusan Q5 ditulis, memuat alternatif yang ditolak
- [ ] Cakupan test ≥ 85%
- [ ] Commit terbuat

## Catatan

Kolom `timezone` mudah terlupa di step ini dan baru terasa akibatnya di Step 25, ketika tenggat pembatalan harus dihitung dengan zona waktu properti. Mengisinya sekarang jauh lebih murah daripada migrasi data belakangan.

Keputusan menaruh katalog di dalam search-service adalah pertimbangan praktis, bukan kemurnian arsitektur. Kalau nanti ada konsumen kedua di luar search, pemisahan menjadi service tersendiri baru punya alasan. Catat pertimbangan ini di ADR — mengakui alasan praktis lebih baik daripada mengarang pembenaran arsitektural.
