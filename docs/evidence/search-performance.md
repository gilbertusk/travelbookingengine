# Bukti performa pencarian

Metrik M1, M2, dan M3 pada [PRD Bab 7.1](../../.claude/prds/travel-booking-engine.prd.md), dan hipotesis pada Bab 6.

> **Status: BELUM DIUKUR.**
>
> Skenario, ambang, dan orkestrasinya sudah ada dan sudah diverifikasi. Angkanya belum — mengukurnya membutuhkan Postgres, Redis, dan Kafka menyala, dan Docker belum berjalan sejak Step 05.
>
> Tabel di bawah sengaja dibiarkan kosong alih-alih diisi perkiraan. Angka yang dikarang di berkas bukti adalah kebohongan yang paling sulit dibatalkan: ia disalin ke README, lalu ke lamaran kerja, dan tidak ada yang tahu dari mana asalnya.

## Target

| ID  | Metrik                    | Target    | Hasil          |
| --- | ------------------------- | --------- | -------------- |
| M1  | Latensi pencarian p95     | < 800ms   | _belum diukur_ |
| M2  | Latensi pencarian p99     | < 1.500ms | _belum diukur_ |
| M3  | Rasio cache hit pencarian | > 70%     | _belum diukur_ |

M1 diuji pada kondisi **terdegradasi**, bukan kondisi ideal. Itulah bunyi hipotesis Bab 6: pencarian tetap di bawah 800ms pada p95 meskipun satu supplier sengaja dibuat merespons 3 detik dan satu supplier lain dimatikan.

## Skenario

| Skenario     | Perintah                        | Yang diukur                                  |
| ------------ | ------------------------------- | -------------------------------------------- |
| Baseline     | `pnpm loadtest:search`          | Angka pembanding, seluruh supplier sehat     |
| Terdegradasi | `pnpm loadtest:search:degraded` | **M1 dan M2** — hipotesis Bab 6              |
| Cache        | `pnpm loadtest:cache`           | **M3** — rasio cache hit pada pola realistis |

Ketiganya gagal secara otomatis bila ambangnya tidak terpenuhi, jadi dapat dijalankan di CI tanpa ada yang membaca keluarannya.

### Kondisi terdegradasi

Disiapkan skrip orkestrasi lewat panel kendali mock-supplier **sebelum** k6 berjalan, dan dikembalikan sesudahnya — termasuk ketika k6 gagal atau dihentikan di tengah jalan.

| Supplier | Kondisi               | Alasan dipilih                                       |
| -------- | --------------------- | ---------------------------------------------------- |
| LUNA     | latensi tetap 3.000ms | Memang sudah paling lambat pada profilnya (2,4–3,2s) |
| ZEPH     | dimatikan             | Memang sudah paling sering gagal (15%)               |
| Lainnya  | bawaan profil         | —                                                    |

Yang dipilih untuk dirusak adalah supplier yang memang sudah paling bermasalah. Memilih yang tercepat akan menghasilkan uji yang lebih mudah dilewati daripada kenyataan.

### Pola cache

40 kriteria berbeda beredar, tersebar di tiga kota populer. Skenarionya berjalan tiga menit dengan puncak 40 VU yang masing-masing menunggu satu detik antar permintaan — kira-kira 5.000 permintaan.

Empat puluh di antaranya meleset karena memang belum ada di cache. TTL lapis pertama lima menit, jadi tidak ada yang kedaluwarsa selama uji berlangsung. Batas bawah rasio yang menyusul: **1 − 40/5.000 ≈ 99%**.

Ambang M3 di 70% karena itu punya ruang besar, dan ruang itu disengaja: ambang yang pas-pasan akan gagal karena satu VU yang kebetulan lambat memulai, bukan karena cache-nya berhenti bekerja.

Asumsi ini sengaja ditulis terang-terangan. Rasio cache hit hanya bermakna kalau pola yang menghasilkannya dapat diperdebatkan — dan pola yang tersembunyi di dalam generator tidak dapat diperdebatkan oleh siapa pun.

## Yang sudah diverifikasi tanpa Docker

`pnpm verify:loadtest` membuktikan skenarionya mengukur apa yang diklaimnya:

- Ambang p95, p99, tingkat galat, dan rasio cache hit **sama persis** dengan PRD Bab 7.1
- Kondisi degradasi **sama persis** dengan hipotesis Bab 6 — satu supplier 3 detik, satu supplier mati, dan keduanya supplier yang berbeda
- Kriteria baseline benar-benar bervariasi: 488 dari 500 benih menghasilkan kriteria berbeda, melawan batas teoretis 487
- Pola cache benar-benar menghasilkan sebanyak yang diminta, diperiksa pada 20, 40, 80, dan 200
- Tidak ada tanggal lampau, tidak ada menginap di atas 30 malam, tidak ada jumlah tamu di luar batas — semuanya akan ditolak 400 dan dilaporkan sebagai galat sistem

Skrip itu diuji dengan sengaja dilanggar: ambang p95 diubah ke 2.000ms dan jumlah kriteria cache ke 9.999, dan keduanya tertangkap dengan pesan yang menyebutkan angkanya.

Orkestrasi kondisi supplier juga sudah dijalankan terhadap mock-supplier sungguhan — yang tidak membutuhkan Docker:

```
seluruh supplier dinormalkan → 200
LUNA dilambatkan ke 3000ms   → 200
ZEPH dimatikan               → 200

LUNA {"latencyMs":[3000,3000],"down":false}
ZEPH {"down":true}

setelah reset LUNA {"down":false}
setelah reset ZEPH {"down":false}
```

Pemeriksaan kesiapan juga terbukti bekerja: dengan hanya mock-supplier menyala, ia menolak berjalan dan menyebutkan tepat dua service yang belum siap.

## Cara menjalankan pengukurannya

```bash
pnpm infra:up

# Basis data dan katalog
pnpm --filter @tbe/auth-service db:migrate
pnpm --filter @tbe/supplier-service db:migrate && pnpm --filter @tbe/supplier-service db:seed
pnpm --filter @tbe/pricing-service db:migrate && pnpm --filter @tbe/pricing-service db:seed
pnpm --filter @tbe/search-service db:migrate

# mock-supplier lebih dulu — seed katalog membaca kebenaran dasar darinya
pnpm --filter @tbe/mock-supplier dev
pnpm --filter @tbe/search-service db:seed

# Seluruh service yang dilewati jalur pencarian
pnpm --filter @tbe/supplier-service dev
pnpm --filter @tbe/pricing-service dev
pnpm --filter @tbe/search-service dev
pnpm --filter @tbe/api-gateway dev
```

Lalu, dengan k6 terpasang — atau dengan `K6_DOCKER=1` untuk menjalankannya lewat image resmi:

```bash
pnpm loadtest:search
pnpm loadtest:search:degraded
pnpm loadtest:cache
```

Ringkasannya tersimpan di `infra/k6/results/` — satu berkas ringkas untuk dikutip, satu berkas mentah untuk diperiksa ulang ketika angkanya diragukan.

### Tangkapan layar Grafana

Belum ada. Dasbor pencarian disiapkan pada Step 06 dan sudah memuat panel untuk latensi pencarian serta rasio cache hit; yang belum ada adalah data untuk ditampilkannya.

Saat mengukur nanti, ambil tangkapan layar **selama uji berlangsung**, bukan setelahnya — panel yang diambil setelah beban berhenti menunjukkan garis yang sudah turun kembali ke nol, dan itu tidak membuktikan apa pun.

## Catatan penyetelan

Belum ada penyetelan karena belum ada pengukuran.

Kalau ambang tidak tercapai nanti, selidiki dengan urutan ini — jangan menebak, dan catat setiap langkahnya di sini **termasuk yang tidak berhasil**:

1. **Trace Jaeger untuk permintaan paling lambat.** Cari span terlama. Tebakan paling mungkin: pemanggilan pricing-service yang menunggu seluruh fan-out selesai, padahal sebagian tawaran sudah dapat dihargai lebih dulu.
2. **Apakah penetapan harga menjadi hambatan.** Satu panggilan untuk seluruh hasil memang sudah benar, tetapi satu panggilan yang memuat 2.000 tawaran tetap satu panggilan yang lambat.
3. **Apakah ada operasi berurutan yang seharusnya paralel.** Kandidat yang sudah diketahui: `deps.suppliers.directory()` dipanggil sebelum fan-out dimulai, dan keduanya tidak saling bergantung.
4. **Apakah anggaran batas waktu terlalu longgar.** 1200ms adalah titik awal, bukan hasil pengukuran. p95 yang mendekati 800ms sementara banyak jawaban parsial berarti anggarannya memang terlalu panjang.
5. **Ukuran muatan dan serialisasi.** Jawaban pencarian memuat seluruh tawaran untuk setiap properti — itu syarat FR-10, tetapi ukurannya belum pernah diukur.

**Ambangnya jangan diturunkan.** Kalau tidak tercapai: perbaiki sistemnya, atau catat dengan jujur mengapa tidak, beserta apa saja yang sudah dicoba. Penilai yang berpengalaman lebih menghargai kejujuran terukur daripada angka yang dipaskan — dan angka yang dipaskan hampir selalu ketahuan dari ambang yang anehnya persis sama dengan hasilnya.
