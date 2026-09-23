# Step 29 — ADR dan README bukti

**Fase 5** · Milestone 6 · Estimasi 5 jam · Prasyarat: Step 28

## Tujuan

Mengubah hasil kerja menjadi sesuatu yang dapat dinilai dalam sepuluh menit. Memenuhi M10 dan P3 sampai P5. Step ini yang menentukan apakah tiga bulan kerjamu terlihat atau tidak.

## Prompt

```
Tulis dokumentasi akhir: catatan keputusan arsitektur dan README utama.

Baca terlebih dahulu PRD Bab 3.2, Bab 5.3, dan seluruh berkas di docs/evidence/.

=== ADR ===

Tulis di docs/adr/ dengan format: konteks, keputusan, alternatif yang
dipertimbangkan, konsekuensi, dan status. Minimal tujuh ADR:

1. Pemisahan peran Kafka dan RabbitMQ
   Ini ADR terpenting. Jelaskan pembedaan peristiwa dan perintah, kenapa
   satu broker saja tidak memadai untuk kedua peran, dan alternatif yang
   ditolak beserta alasannya. Ini jawaban langsung untuk risiko R4 di PRD

2. Database terpisah per service
   Termasuk konsekuensinya: tidak ada join lintas service, dan bagaimana
   itu diatasi

3. Saga orkestrasi, bukan koreografi
   Kenapa orkestrasi dipilih untuk domain ini, dan kapan koreografi
   akan lebih tepat

4. Tidak melakukan refund saat status supplier tidak dapat dipastikan
   Keputusan yang paling menarik secara bisnis. Jelaskan trade-off-nya

5. Caching berlapis dan price check wajib
   Kenapa harga hasil cache tidak pernah cukup untuk pembayaran

6. Tanpa Elasticsearch
   Kenapa mengindeks data supplier adalah salah paham terhadap domain

7. Keputusan Q1 sampai Q7 yang diambil sepanjang pengerjaan

ADR ditulis untuk pembaca yang belum pernah melihat kode ini. Setiap ADR
menyebutkan alternatif yang ditolak — ADR tanpa alternatif hanya deskripsi,
bukan keputusan.

=== README utama ===

Struktur, dengan urutan ini persis. Penilai membaca dari atas dan berhenti
kapan saja, jadi yang paling meyakinkan harus di atas:

1. Satu paragraf: apa ini dan masalah apa yang dipecahkan
2. Demo langsung: tautan, kredensial uji, dan tautan video 2 menit
3. Bukti terukur, dalam bentuk tabel:
   - Latensi pencarian p95 pada kondisi supplier terdegradasi
   - Rasio cache hit
   - Hasil uji konkurensi: 1000 permintaan, 10 ketersediaan, 10 berhasil,
     0 ganda
   - Hasil uji chaos: seluruh pemesanan mencapai keadaan final
   - Cakupan test
   Setiap angka menautkan ke berkas bukti di docs/evidence/
4. Diagram arsitektur, satu gambar
5. Tangkapan layar trace Jaeger dari satu alur kompensasi lengkap
6. Bagaimana masalah sulit dipecahkan — empat masalah dari PRD Bab 2.2,
   masing-masing satu paragraf pendek dengan tautan ke kodenya
7. Cerita kegagalan: satu atau dua hal yang awalnya salah dan bagaimana
   diperbaiki. Ambil dari catatan penyetelan di Step 15 dan Step 22.
   Bagian ini sering yang paling diingat pembaca
8. Cara menjalankan: harus benar-benar cukup satu perintah
9. Tautan ke ADR
10. Apa yang sengaja tidak dibangun, dan kenapa

Aturan penulisan:
- Jangan mengklaim apa pun yang tidak ada buktinya di docs/evidence/
- Jangan menulis "scalable", "production-ready", atau "enterprise-grade"
  tanpa angka yang mendukung
- Bahasa Inggris untuk README utama, karena audiensnya bisa lebih luas
- Diagram dibuat dengan Mermaid supaya ikut versi kontrol

=== Verifikasi ===

Uji README dengan menjalankan langkah "cara menjalankan" pada folder yang
benar-benar bersih, hasil clone baru. Bila ada satu langkah saja yang
tidak tertulis, perbaiki.

Commit: docs: add architecture decision records and evidence readme
```

## Definisi Selesai

- [ ] Minimal tujuh ADR ditulis, masing-masing memuat alternatif yang ditolak
- [ ] README memuat tabel bukti terukur dengan tautan ke berkas bukti
- [ ] Setiap klaim di README punya bukti yang dapat ditelusuri
- [ ] Diagram arsitektur dan tangkapan trace Jaeger ada
- [ ] Bagian cerita kegagalan ditulis jujur
- [ ] Langkah "cara menjalankan" diuji pada hasil clone bersih dan berhasil
- [ ] Tidak ada klaim tanpa angka pendukung
- [ ] Commit terbuat

## Catatan

Uji README pada clone bersih hampir selalu menemukan dua sampai tiga langkah yang hilang — biasanya berkas env atau pembuatan topik Kafka. Penilai yang gagal menjalankan project di percobaan pertama jarang mencoba yang kedua.
