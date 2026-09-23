# Step 27 — analytics-service dan panel operator

**Fase 5** · Milestone 6 · Estimasi 8 jam · Prasyarat: Step 26 · Q6 sudah dijawab: aplikasi terpisah

## Tujuan

Menunjukkan bahwa aliran peristiwa Kafka punya konsumen sungguhan, dan menyediakan alat bagi operator. Ini step yang paling boleh dipangkas bila waktu menipis.

## Prompt

```
Buat apps/analytics-service dan panel operator.

Baca terlebih dahulu PRD FR-29 sampai FR-33, keputusan Q6, dan
docs/plan/DESIGN-SYSTEM.md.

=== analytics-service ===

1. Consumer peristiwa
   - Mengonsumsi seluruh topik Kafka sebagai pembaca independen
   - Consumer group terpisah, sehingga tidak mengganggu alur utama
   - Ini demonstrasi nyata keunggulan Kafka: menambah konsumen baru tanpa
     menyentuh satu pun service yang sudah ada

2. Agregasi
   - Corong konversi: pencarian, lihat detail, hold, bayar, konfirmasi
   - Performa supplier: latensi, tingkat kegagalan, kontribusi hasil,
     tingkat perubahan harga
   - Kota dan rentang tanggal terpopuler
   - Tingkat kegagalan pemesanan beserta sebabnya
   - Simpan agregat di PostgreSQL. Jangan memakai ClickHouse — lihat
     PRD Bab 12 soal menghindari perkakas yang belum dibutuhkan

3. Replay
   - Sediakan cara membangun ulang seluruh agregat dari awal topik
   - Ini bukti konkret kemampuan replay Kafka, dan layak disebut di ADR
   - Buktikan dengan menghapus agregat lalu membangunnya kembali

=== Panel operator ===

Keputusan Q6: aplikasi Next.js terpisah di apps/ops, berbagi packages/ui
dengan apps/web supaya tampilannya konsisten.

Alasan pemisahan, dan ini yang harus ditegakkan: kode operator tidak boleh
pernah ikut terkirim ke bundel yang diakses publik. Batas keamanannya fisik,
bukan sekadar pemeriksaan peran. Konsekuensinya apps/ops di-deploy terpisah
dan tidak perlu diakses publik.

4. Halaman yang dibutuhkan
   - Kesehatan supplier (FR-31): latensi, tingkat galat, keadaan pemutus
     sirkuit, secara langsung
   - Konfigurasi supplier (FR-29): aktifkan, nonaktifkan, ubah pengaturan
   - Aturan markup (FR-30): CRUD dengan pratinjau dampak
   - Daftar pemesanan NEEDS_REVIEW dengan seluruh konteksnya: riwayat
     booking_events, catatan permintaan supplier, dan status pembayaran.
     Halaman ini yang membuat keadaan NEEDS_REVIEW benar-benar dapat
     ditindaklanjuti, bukan sekadar tempat pembuangan
   - Panel kendali mock-supplier (FR-32): antarmuka untuk menyuntikkan
     latensi dan kegagalan. Ini yang akan kamu pakai saat demo

5. Desain
   - Fungsional, tidak perlu dipoles. Ikuti token dan primitif yang sama
     supaya tetap konsisten, tetapi jangan investasikan waktu pada tampilan
   - Tabel padat boleh di sini, tidak seperti di aplikasi pengguna
   - Akses dibatasi peran operator, diperiksa di gateway dan di service

Commit: feat: add analytics service and operator panel
```

## Definisi Selesai

- [ ] analytics-service mengonsumsi peristiwa tanpa mengganggu alur utama
- [ ] Agregat dapat dibangun ulang dari awal topik — dibuktikan dengan menghapus lalu membangun ulang
- [ ] Halaman kesehatan supplier menampilkan keadaan pemutus sirkuit secara langsung
- [ ] Halaman `NEEDS_REVIEW` menampilkan seluruh konteks yang dibutuhkan untuk mengambil keputusan
- [ ] Panel kendali mock-supplier dapat dipakai menyuntikkan kegagalan saat demo
- [ ] Akses operator diperiksa di gateway dan di service, bukan hanya disembunyikan di antarmuka
- [ ] Commit terbuat

## Catatan

Panel kendali mock-supplier terlihat seperti alat internal, tetapi saat demo ia menjadi bintangnya: kamu matikan satu supplier di depan penilai, lalu tunjukkan pencarian tetap jalan dan pemesanan tetap direfund. Itu lebih meyakinkan daripada tabel angka mana pun.
