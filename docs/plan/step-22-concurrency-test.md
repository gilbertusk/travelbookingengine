# Step 22 — Uji beban konkurensi

**Fase 3** · Milestone 4 · Estimasi 4 jam · Prasyarat: Step 21

## Tujuan

Membuktikan M5 dan M6: nol pemesanan ganda, dan nol uang tertahan. Ini angka yang paling sering dikutip saat orang membaca README project semacam ini.

## Prompt

```
Buat rangkaian uji beban konkurensi untuk alur pemesanan dan buktikan
metrik M5 dan M6 pada PRD.

Baca terlebih dahulu PRD Bab 7.1, US-04, dan US-05.

1. Skenario k6 di infra/k6/
   - booking-contention.js
     1000 pengguna virtual mencoba memesan rate plan yang sama secara serentak,
     dengan ketersediaan hanya 10. Ini implementasi langsung US-04
   - booking-supplier-failure.js
     Beban pemesanan normal, lalu supplier dimatikan di tengah lewat panel
     kendali mock-supplier. Mengukur berapa banyak yang mencapai keadaan final
     dan berapa yang direfund
   - booking-idempotency.js
     Permintaan berulang dengan idempotency key sama, dikirim serentak

2. Verifikasi setelah uji
   Skrip verifikasi yang dijalankan setelah setiap skenario dan memeriksa
   langsung ke database serta Redis:
   - Jumlah pemesanan CONFIRMED tepat sama dengan ketersediaan awal
   - Tidak ada booking reference supplier yang muncul lebih dari sekali
   - Setiap pembayaran berhasil punya pemesanan terkonfirmasi atau refund
   - Tidak ada pemesanan tertinggal di keadaan tidak final
   - Tidak ada kunci hold yatim di Redis
   - Jumlah pemesanan di mock-supplier sama dengan jumlah CONFIRMED di sistem kita

   Skrip ini gagal bila satu invarian saja dilanggar.

3. Pengukuran tambahan
   - Latensi p95 alur hold
   - Waktu dari pembayaran sampai konfirmasi
   - Waktu dari kegagalan sampai refund selesai
   - Jumlah pemesanan yang berakhir di NEEDS_REVIEW, beserta sebabnya

4. Bukti
   - Buat docs/evidence/booking-concurrency.md berisi: konfigurasi uji,
     hasil tiap skenario, keluaran skrip verifikasi, dan tangkapan layar Grafana
   - Sertakan juga trace Jaeger dari satu alur kompensasi lengkap.
     Gambar ini menjelaskan arsitektur lebih baik daripada diagram mana pun

5. Bila ada invarian yang dilanggar
   Jangan melanjutkan ke step berikutnya. Selidiki dengan urutan:
   - Periksa apakah pengurangan ketersediaan benar-benar atomik
   - Periksa apakah ada jalur yang melewati skrip Lua
   - Periksa apakah batasan unik idempotency benar-benar ada di database
   - Periksa trace untuk alur yang menghasilkan pelanggaran
   Catat temuan dan perbaikannya — ini bahan bagus untuk bagian
   "cerita kegagalan" di README nanti

Commit: test: add booking concurrency load tests and evidence
```

## Definisi Selesai

- [ ] M5 tercapai: 1000 permintaan serentak untuk ketersediaan 10 menghasilkan tepat 10 CONFIRMED
- [ ] Tidak ada booking reference supplier yang ganda
- [ ] M6 tercapai: setiap pembayaran berhasil berakhir terkonfirmasi atau direfund
- [ ] Tidak ada pemesanan tertinggal di keadaan tidak final
- [ ] Tidak ada kunci hold yatim di Redis
- [ ] Jumlah pemesanan di mock-supplier cocok dengan jumlah CONFIRMED
- [ ] Skrip verifikasi gagal otomatis bila satu invarian dilanggar
- [ ] `docs/evidence/booking-concurrency.md` berisi hasil, tangkapan Grafana, dan trace Jaeger
- [ ] Commit terbuat

## Catatan

Pemeriksaan "jumlah pemesanan di mock-supplier cocok dengan jumlah CONFIRMED" adalah yang paling jarang dilakukan orang, dan yang paling meyakinkan. Ia membuktikan tidak ada pemesanan bayangan di sisi supplier yang tidak tercatat di sistem kita.
