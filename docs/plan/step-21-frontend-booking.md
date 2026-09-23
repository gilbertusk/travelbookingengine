# Step 21 — Frontend: alur pemesanan

**Fase 3** · Milestone 4 · Estimasi 8 jam · Prasyarat: Step 20

## Tujuan

Menjadikan kerumitan saga di belakang layar terasa tenang bagi pengguna. Dua momen paling sulit dirancang: harga berubah, dan menunggu konfirmasi supplier.

## Prompt

```
Bangun alur pemesanan lengkap di apps/web.

Baca terlebih dahulu:
- docs/plan/DESIGN-SYSTEM.md, terutama bagian 6 dan 7
- PRD FR-13 sampai FR-24, US-02, US-03

1. Halaman pemilihan rate plan
   - Dari halaman detail properti, memilih rate plan membuka alur pemesanan
   - Ringkasan menginap terlihat terus: properti, tanggal, jumlah malam, tamu
   - PriceDisplay dengan rincian lengkap. Jangan menyembunyikan pajak sampai
     langkah terakhir

2. Formulir data tamu (FR-17)
   - React Hook Form dan Zod, skema dibagikan dengan backend bila memungkinkan
   - Validasi saat blur, bukan saat setiap ketukan
   - Galat ditampilkan di dekat input yang bersangkutan, bukan sebagai daftar di atas
   - Setiap input punya label sungguhan

3. HoldCountdown (FR-15)
   - Menampilkan sisa waktu hold, disinkronkan dengan waktu server bukan jam lokal
   - Netral di atas 5 menit, warning di bawahnya, sesuai dokumen desain
   - Jangan berkedip
   - Saat habis, tampilkan keadaan yang jelas dengan aksi kembali ke pencarian
   - Umumkan sisa waktu lewat aria-live pada ambang tertentu saja, bukan setiap detik

4. RateChangeDialog (FR-14, US-02)
   Ini momen paling penting dirancang dengan benar:
   - Muncul ketika price check mengembalikan harga berbeda
   - Tampilkan harga lama, harga baru, dan selisihnya secara eksplisit
   - Nada tenang dan faktual. Jangan memakai warna merah atau bahasa alarm —
     ini kondisi normal, bukan kesalahan
   - Aksi utama "Terima harga baru", aksi sekunder "Kembali ke hasil pencarian"
   - Dialog mengunci fokus dan dapat ditutup dengan Escape
   - Bila harga berubah lagi setelah diterima, dialog muncul lagi tanpa
     merusak keadaan

5. Pembayaran (FR-19)
   - Arahkan ke Snap Midtrans sesuai keputusan Q1, dalam mode popup atau
     halaman penuh. Popup lebih baik karena pengguna tidak kehilangan
     konteks pemesanannya
   - Jangan mengandalkan callback sisi klien dari Snap sebagai penentu
     keberhasilan. Kebenaran ada pada notifikasi server. Callback klien
     hanya dipakai untuk memindahkan pengguna ke halaman status
   - Halaman kembali menangani tiga kemungkinan: sukses, gagal, dan
     pengguna menutup tanpa menyelesaikan

6. Halaman status pemesanan (FR-26, US-03)
   Bagian yang menunjukkan kemampuan realtime:
   - Setelah pembayaran, tampilkan BookingStatusTimeline
   - Berlangganan endpoint SSE dari Step 19
   - Tahapan: pembayaran diterima, mengonfirmasi ke penyedia, pemesanan
     dikonfirmasi, voucher diterbitkan
   - Tangani putus koneksi SSE dengan penyambungan ulang otomatis, dan
     cadangan berupa polling bila SSE gagal berulang
   - Keadaan gagal: jelaskan apa yang terjadi dan status pengembalian dana
     dengan bahasa manusia. Jangan menampilkan kode galat internal
   - Keadaan NEEDS_REVIEW: jelaskan bahwa pemesanan sedang diperiksa dan
     kapan pengguna akan dihubungi. Jangan berpura-pura berhasil atau gagal

7. Halaman konfirmasi (FR-24)
   - Booking reference ditampilkan menonjol
   - Tautan unduh voucher
   - Ringkasan menginap dan rincian biaya

8. Penanganan galat menyeluruh
   - Setiap kegagalan jaringan punya jalan keluar yang jelas
   - Tidak ada layar buntu tanpa aksi
   - Kegagalan yang terjadi setelah pembayaran TIDAK boleh menampilkan pesan
     generik. Pengguna harus tahu uangnya aman

Sebelum menutup step, periksa seluruh butir DESIGN-SYSTEM.md bagian 11.

Commit: feat: add booking flow experience
```

## Definisi Selesai

- [ ] Hitung mundur hold disinkronkan dengan waktu server, bukan jam lokal
- [ ] Dialog perubahan harga bernada tenang, bukan alarm, dan mengunci fokus
- [ ] Perubahan harga berulang ditangani tanpa merusak keadaan
- [ ] Status pemesanan diperbarui langsung lewat SSE
- [ ] SSE menyambung ulang otomatis dan punya cadangan polling
- [ ] Keadaan gagal menjelaskan status dana dengan bahasa manusia
- [ ] Keadaan `NEEDS_REVIEW` punya tampilan sendiri yang jujur
- [ ] Tidak ada layar buntu tanpa aksi
- [ ] Seluruh alur dapat diselesaikan dengan keyboard saja
- [ ] Tampilan benar pada lebar 375px, aksi utama menempel di bawah
- [ ] Seluruh butir DESIGN-SYSTEM.md bagian 11 tercentang
- [ ] Commit terbuat

## Catatan

Menyinkronkan hitung mundur dengan waktu server terdengar berlebihan sampai ada pengguna yang jam komputernya meleset lima menit dan melihat hold-nya habis padahal masih ada waktu. Hitung selisih waktu sekali saat halaman dimuat, lalu pakai selisih itu.
