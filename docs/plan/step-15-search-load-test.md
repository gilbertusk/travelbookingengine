# Step 15 — Uji beban pencarian

**Fase 2** · Milestone 3 · Estimasi 4 jam · Prasyarat: Step 14

## Tujuan

Mengubah klaim menjadi angka. Metrik M1, M2, dan M3 dibuktikan di sini, dan hasilnya menjadi bahan utama README.

## Prompt

```
Buat rangkaian uji beban untuk alur pencarian dan buktikan metrik M1, M2, dan M3
pada PRD.

Baca PRD Bab 7.1 terlebih dahulu.

1. Skenario k6 di infra/k6/
   - search-baseline.js — seluruh supplier sehat, beban bertahap naik
   - search-degraded.js — satu supplier dilambatkan ke 3 detik dan satu
     dimatikan lewat panel kendali mock-supplier. Ini skenario yang
     membuktikan hipotesis pada PRD Bab 6
   - search-cache.js — pola pencarian realistis dengan pengulangan kriteria,
     untuk mengukur rasio cache hit
   - Seluruh skenario memakai kriteria pencarian yang bervariasi, bukan satu
     kriteria yang diulang, kecuali skenario cache

2. Ambang di dalam skenario
   - p95 di bawah 800ms
   - p99 di bawah 1500ms
   - Tingkat galat di bawah 1%
   - Skenario gagal bila ambang tidak terpenuhi, sehingga bisa dijalankan di CI

3. Orkestrasi
   - Skrip yang menyiapkan kondisi supplier lewat endpoint admin mock-supplier
     sebelum uji, dan mengembalikannya ke normal setelahnya
   - Skrip pnpm: loadtest:search, loadtest:search:degraded, loadtest:cache

4. Pengukuran dan pencatatan
   - Simpan ringkasan hasil sebagai JSON di infra/k6/results/
   - Buat docs/evidence/search-performance.md berisi: kondisi uji,
     konfigurasi supplier, hasil p50 p95 p99, rasio cache hit, dan
     tangkapan layar dasbor Grafana selama uji berlangsung

5. Penyetelan bila ambang belum terpenuhi
   Selidiki dengan urutan ini, jangan menebak:
   - Lihat trace Jaeger untuk permintaan paling lambat, cari span terlama
   - Periksa apakah penetapan harga menjadi hambatan
   - Periksa apakah ada operasi berurutan yang seharusnya paralel
   - Periksa apakah anggaran batas waktu terlalu longgar
   - Periksa ukuran payload dan serialisasi
   Setelah setiap perubahan, jalankan ulang dan catat perbedaannya.
   Simpan catatan penyetelan ini — ia lebih menarik bagi penilai daripada
   hasil akhirnya sendiri

Commit: test: add search load test scenarios and evidence
```

## Definisi Selesai

- [ ] Tiga skenario k6 ada dan dapat dijalankan dengan satu perintah
- [ ] Skenario gagal secara otomatis bila ambang tidak terpenuhi
- [ ] M1 tercapai: p95 di bawah 800ms pada kondisi supplier terdegradasi
- [ ] M2 tercapai: p99 di bawah 1500ms
- [ ] M3 tercapai: rasio cache hit di atas 70%
- [ ] `docs/evidence/search-performance.md` berisi hasil dan tangkapan layar Grafana
- [ ] Catatan penyetelan tersimpan, termasuk yang tidak berhasil
- [ ] Commit terbuat

## Catatan

Kalau ambang tidak tercapai, jangan turunkan ambangnya. Perbaiki sistemnya, atau catat dengan jujur mengapa tidak tercapai beserta apa yang sudah dicoba. Penilai yang berpengalaman lebih menghargai kejujuran terukur daripada angka yang dipaskan.
