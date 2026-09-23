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

- [ ] Satu supplier lambat tidak membuat pencarian melewati anggaran waktu
- [ ] Supplier mati dilewati tanpa penundaan karena pemutus sirkuit
- [ ] Hasil supplier lambat tetap masuk cache dan berguna pada pencarian berikutnya
- [ ] Cache stampede dicegah — dibuktikan dengan test seratus permintaan serentak
- [ ] Deduplikasi lintas supplier bekerja terhadap data mock-supplier
- [ ] Metadata hasil parsial dikembalikan dan akurat
- [ ] Penetapan harga dilakukan dalam satu panggilan untuk seluruh hasil
- [ ] Peristiwa `search.performed` terbit tanpa data pribadi
- [ ] Cakupan test ≥ 85%
- [ ] Commit terbuat

## Catatan

Membiarkan supplier lambat selesai di latar belakang adalah detail yang membedakan implementasi serius dari yang asal jalan. Tanpa itu, supplier lambat tidak pernah berkontribusi sama sekali dan inventarisnya hilang selamanya dari hasil pencarian.
