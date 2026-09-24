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

- [x] Tiga skenario k6 ada dan dapat dijalankan dengan satu perintah
- [x] Skenario gagal secara otomatis bila ambang tidak terpenuhi
- [ ] M1 tercapai: p95 di bawah 800ms pada kondisi supplier terdegradasi — **belum diukur**, Docker mati
- [ ] M2 tercapai: p99 di bawah 1500ms — **belum diukur**
- [ ] M3 tercapai: rasio cache hit di atas 70% — **belum diukur**
- [x] `docs/evidence/search-performance.md` ada — berisi skenario, asumsi, dan yang sudah diverifikasi; tabel hasilnya sengaja kosong
- [ ] Tangkapan layar Grafana — **belum ada**, tidak ada data untuk ditampilkan
- [x] Catatan penyetelan tersimpan — urutan penyelidikan beserta kandidat hambatan yang sudah diketahui
- [x] Commit terbuat

## Catatan

Step ini adalah yang pertama yang **tidak dapat diselesaikan** tanpa Docker. Yang dapat dikerjakan dikerjakan sampai tuntas; yang tidak, dibiarkan kosong alih-alih diisi perkiraan.

Angka yang dikarang di berkas bukti adalah kebohongan yang paling sulit dibatalkan: ia disalin ke README, lalu ke lamaran kerja, dan tidak ada yang tahu lagi dari mana asalnya.

### Temuan saat mengerjakan step ini

**1. Uji beban punya satu cara gagal yang khas: berjalan mulus sambil mengukur hal yang salah.** Generator kriteria yang diam-diam menghasilkan kota yang sama menghasilkan p95 cemerlang dan rasio cache hit 99% — keduanya tidak berarti apa pun, dan tidak ada apa pun di keluaran k6 yang menunjukkannya. Itu sebabnya `scripts/verify-loadtest.mjs` ada: ia memeriksa GENERATORNYA, bukan hasilnya.

**2. Skrip itu langsung menemukan dua cacat yang saya tulis sendiri.** Pertama, `variedCriteria` hanya menghasilkan 120 kriteria berbeda dari 500 benih — keempat pengali pada `seed * k % n` berbagi faktor, jadi kombinasinya berulang jauh lebih cepat daripada perkalian jumlah nilai di setiap sumbu. Kedua, `realisticCriteria` melesetkan rasio pengulangannya jauh: diminta 80%, terukur 96%.

**3. Cacat kedua ternyata bukan bug melainkan konsep yang keliru.** "Rasio pengulangan" tidak dapat dijanjikan generator, karena ia bergantung pada berapa kali generator dipanggil — seratus permintaan ke empat puluh kriteria berulang 60%, sepuluh ribu permintaan ke empat puluh kriteria yang sama berulang 99,6%. Yang dapat dijanjikan generator hanyalah BERAPA BANYAK kriteria berbeda yang beredar. Parameternya diganti menjadi `distinctCount`, dan rasio cache hit yang menyusul dihitung di skenario — yang memang tahu berapa lama ia berjalan.

**4. Generator pola cache diam-diam mentok di 42.** Setelah diperbaiki, meminta 80 kriteria berbeda tetap menghasilkan 42: tanggalnya hanya membentang 14 nilai, dan lama menginap ikut berputar bersama kota karena keduanya memakai `% 3`. Pembagiannya diubah menjadi bertingkat, dan batas atasnya kini dinyatakan sebagai `MAX_DISTINCT_CRITERIA` yang ikut diperiksa.

**5. Pencampuran benih yang lemah, bukan ambang yang terlalu ketat.** Setelah perbaikan pertama, `variedCriteria` menghasilkan 448 kriteria berbeda dari 500 — sedikit di bawah ambang 90% yang saya pasang. Godaannya adalah menurunkan ambang ke 85%. Yang dilakukan: menghitung batas teoretisnya lebih dulu (tabrakan ulang tahun atas 9.600 kombinasi memberi 487), melihat bahwa 448 jauh di bawahnya, lalu mengganti xorshift dengan splitmix32. Hasilnya 488 — di atas batas teoretis, dan ambangnya tidak disentuh.

**6. Ambang tidak boleh disalin ke tiga berkas.** Ambang yang disalin akan berbeda di salah satunya dalam hitungan minggu, dan yang berbeda itu justru yang dilaporkan lulus. Ketiganya membaca `lib/config.mjs`, dan skrip verifikasi membandingkan isinya dengan angka PRD.

**7. `http_req_duration` harus disaring lewat tag.** Tanpa penyaringan, permintaan penyiapan dan pembacaan metrik ikut terhitung — keduanya jauh lebih cepat daripada pencarian, jadi p95 yang dilaporkan lebih baik daripada yang sebenarnya dialami pengguna. Tag yang lupa dipasang punya kegagalan yang lebih halus lagi: ambangnya tidak pernah dievaluasi, dan k6 melaporkannya lulus.

**8. Kode status saja tidak cukup untuk memeriksa pencarian.** Pencarian yang menjawab 200 dengan daftar kosong adalah pencarian yang gagal. Uji beban yang hanya memeriksa 200 akan melaporkan keberhasilan penuh terhadap sistem yang tidak mengembalikan satu pun hotel — dan hasil itu masuk ke README sebagai bukti.

**9. Kondisi supplier harus disiapkan DI LUAR k6.** Menyiapkannya dari dalam skenario berarti VU pertama berjalan sebelum kondisinya sempat berlaku, dan permintaan-permintaan awal itu mengukur kondisi sehat sambil dilaporkan sebagai terdegradasi. Orkestrasinya juga menormalkan supplier SEBELUM uji, bukan hanya sesudah: suntikan yang tertinggal dari skenario sebelumnya adalah penyebab paling umum uji berikutnya gagal tanpa sebab yang jelas.

**10. Yang dirusak adalah supplier yang memang sudah paling bermasalah.** LUNA sudah paling lambat (2,4–3,2 detik), ZEPH sudah paling sering gagal (15%). Memilih yang tercepat untuk dirusak akan menghasilkan uji yang lebih mudah dilewati daripada kenyataan — dan angkanya tetap dapat dilaporkan sebagai "satu supplier 3 detik, satu supplier mati".

### Yang sudah diverifikasi tanpa Docker

`pnpm verify:loadtest` hijau, dan diuji dengan sengaja dilanggar: ambang p95 diubah ke 2.000ms dan jumlah kriteria cache ke 9.999 — keduanya tertangkap dengan pesan yang menyebutkan angkanya.

Orkestrasi kondisi supplier dijalankan terhadap mock-supplier sungguhan, yang tidak membutuhkan Docker:

```
LUNA dilambatkan ke 3000ms → 200    LUNA {"latencyMs":[3000,3000],"down":false}
ZEPH dimatikan             → 200    ZEPH {"down":true}
setelah reset                        LUNA {"down":false}  ZEPH {"down":false}
```

Pemeriksaan kesiapan juga terbukti: dengan hanya mock-supplier menyala, ia menolak berjalan dan menyebutkan tepat dua service yang belum siap.

### Yang belum diverifikasi

**Seluruh angkanya.** k6 belum pernah dijalankan — binernya tidak terpasang, dan image Docker-nya membutuhkan Docker yang sama matinya dengan Postgres.

Yang belum terbukti selain angkanya: `handleSummary` belum pernah menulis satu berkas pun, ambang k6 belum pernah benar-benar gagal atau lulus, dan bentuk `data.metrics` yang dibaca `lib/summary.mjs` berasal dari dokumentasi k6, bukan dari keluaran yang pernah dilihat sendiri. Kalau nanti ringkasannya kosong atau `null` di mana-mana, di sanalah tempat pertama yang harus diperiksa.

Perintah lengkapnya ada di `docs/evidence/search-performance.md`, beserta urutan penyelidikan bila ambangnya tidak tercapai.

Satu hal yang harus dijaga saat mengukur nanti: **ambangnya jangan diturunkan.** Kalau tidak tercapai, perbaiki sistemnya atau catat dengan jujur mengapa tidak. Angka yang dipaskan hampir selalu ketahuan dari ambang yang anehnya persis sama dengan hasilnya.
