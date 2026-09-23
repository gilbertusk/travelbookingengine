# Step 28 — Chaos test dan rekonsiliasi

**Fase 5** · Milestone 6 · Estimasi 8 jam · Prasyarat: Step 27 · Q4 sudah dijawab: rekonsiliasi masuk MVP

## Tujuan

Membuktikan M11: sistem pulih dari kegagalan yang terjadi di titik paling buruk. Dan menyediakan jaring pengaman terakhir berupa rekonsiliasi dengan supplier.

## Prompt

```
Bangun rangkaian uji chaos dan pekerjaan rekonsiliasi.

Baca terlebih dahulu PRD M6, M11, FR-33, dan keputusan Q4.

=== Uji chaos ===

1. Skenario
   Setiap skenario menjalankan beban pemesanan normal, lalu menyuntikkan
   satu kegagalan pada waktu yang paling merugikan:

   - Supplier mati tepat setelah pembayaran berhasil, sebelum konfirmasi
   - Supplier mati tepat setelah konfirmasi berhasil, sebelum respons diterima.
     Ini kasus ketidakpastian yang paling sulit
   - booking-service dimatikan di tengah saga
   - RabbitMQ dimatikan selama 30 detik lalu dihidupkan
   - Kafka dimatikan selama 30 detik lalu dihidupkan
   - Redis dimatikan selama 10 detik lalu dihidupkan
   - PostgreSQL menolak koneksi sementara
   - Penyedia pembayaran mengirim webhook terlambat 5 menit
   - Penyedia pembayaran mengirim webhook ganda dengan urutan terbalik

   Catatan penting untuk dua skenario pembayaran terakhir:
   Keputusan Q1 memakai sandbox Midtrans, dan sandbox tidak dapat diperintah
   mengirim webhook gagal, terlambat, atau terbalik sesuai kehendak. Karena itu
   kedua skenario ini menyuntikkan kegagalan di batas port PaymentGateway,
   bukan di penyedia. Payload yang dipakai adalah rekaman notifikasi Midtrans
   sungguhan dari sandbox, termasuk tanda tangannya, sehingga verifikasi tanda
   tangan tetap diuji dengan data asli. Catat pendekatan ini di laporan chaos —
   menjelaskan batasan alat uji lebih jujur daripada diam-diam melewatkannya.

2. Yang diverifikasi setelah setiap skenario
   Gunakan helper assertInvariants dari Step 20:
   - Seluruh pemesanan mencapai keadaan final dalam waktu terbatas
   - Tidak ada pembayaran berhasil tanpa konfirmasi atau refund
   - Tidak ada pemesanan bayangan di sisi supplier
   - Tidak ada hold yatim
   - Pemesanan yang tidak dapat diselesaikan otomatis berada di NEEDS_REVIEW,
     bukan menggantung di keadaan lain

3. Otomasi
   - Skrip pnpm chaos:run yang menjalankan seluruh skenario berurutan
   - Setiap skenario mengembalikan sistem ke keadaan bersih sesudahnya
   - Hasil disimpan sebagai laporan

=== Rekonsiliasi (FR-33) ===

4. Pekerjaan berkala
   Keputusan Q4: rekonsiliasi TERMASUK MVP. Ini bukan bagian opsional.
   - Consumer RabbitMQ untuk perintah reconciliation.run, dipicu penjadwal
   - Membandingkan pemesanan di sistem dengan catatan supplier lewat getBooking
   - Ketidaksesuaian yang dicari:
     pemesanan CONFIRMED di sistem tapi tidak ada di supplier
     pemesanan ada di supplier tapi tidak CONFIRMED di sistem
     nilai atau tanggal berbeda
   - Setiap ketidaksesuaian dicatat dan pemesanannya dipindahkan ke
     NEEDS_REVIEW, tidak diperbaiki otomatis. Perbaikan otomatis terhadap
     data finansial tanpa pengawasan lebih berbahaya daripada masalah aslinya
   - Laporan rekonsiliasi dapat dilihat di panel operator

5. Bukti
   - Buat docs/evidence/chaos-report.md berisi seluruh skenario, hasilnya,
     waktu pemulihan, dan berapa banyak yang berakhir di NEEDS_REVIEW
   - Sertakan trace Jaeger dari satu pemulihan lengkap

Commit: test: add chaos scenarios and reconciliation job
```

## Definisi Selesai

- [ ] Seluruh sembilan skenario chaos ada dan dapat dijalankan dengan satu perintah
- [ ] M11 tercapai: seluruh pemesanan mencapai keadaan final pada setiap skenario
- [ ] Tidak ada pemesanan bayangan di sisi supplier pada skenario mana pun
- [ ] Rekonsiliasi mendeteksi ketidaksesuaian dan memindahkan ke `NEEDS_REVIEW`
- [ ] Rekonsiliasi tidak memperbaiki data finansial secara otomatis
- [ ] `docs/evidence/chaos-report.md` berisi hasil lengkap dan trace pemulihan
- [ ] Keputusan Q4 tercatat
- [ ] Commit terbuat

## Catatan

Skenario "supplier mati tepat setelah konfirmasi berhasil, sebelum respons diterima" adalah kasus terburuk di seluruh domain ini: pemesanan sudah ada, tetapi sistem tidak tahu. Kalau sistemmu menanganinya dengan benar lewat `getBooking` dan bukan dengan refund membabi buta, kamu sudah memecahkan masalah yang membuat banyak sistem produksi sungguhan kehilangan uang.
