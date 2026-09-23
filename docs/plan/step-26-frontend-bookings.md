# Step 26 — Frontend: daftar pemesanan dan pembatalan

**Fase 4** · Milestone 5 · Estimasi 5 jam · Prasyarat: Step 25

## Tujuan

Menutup pengalaman pengguna. Memenuhi FR-25 dan FR-27 di sisi antarmuka, termasuk menampilkan keadaan-keadaan sulit dengan jujur.

## Prompt

```
Bangun halaman daftar pemesanan dan alur pembatalan di apps/web.

Baca terlebih dahulu docs/plan/DESIGN-SYSTEM.md dan PRD FR-25, FR-27.

1. Halaman daftar pemesanan (FR-25)
   - Kelompokkan: akan datang, selesai, dibatalkan
   - Setiap entri menampilkan properti, tanggal, booking reference, status,
     dan nilai
   - Status ditampilkan dengan kata-kata, bukan hanya warna. Warna tidak
     boleh menjadi satu-satunya pembawa informasi
   - Keadaan kosong yang dirancang, dengan aksi menuju pencarian
   - Pemuatan berhalaman bila daftar panjang

2. Halaman detail pemesanan
   - Ringkasan menginap lengkap
   - Rincian biaya yang sama dengan yang dibayarkan
   - Kebijakan pembatalan yang berlaku, dengan tenggat dinyatakan sebagai
     tanggal dan waktu konkret, bukan "24 jam sebelum"
   - Tautan unduh voucher
   - BookingStatusTimeline untuk pemesanan yang masih berproses

3. Alur pembatalan (FR-27)
   - Tombol batalkan hanya muncul bila pemesanan memang layak dibatalkan
   - Dialog konfirmasi menampilkan hasil pratinjau: nilai yang kembali,
     nilai yang hangus, dan perkiraan waktu pengembalian
   - Nilai pengembalian ditampilkan SEBELUM pengguna menekan tombol akhir
   - Setelah dikirim, tampilkan status proses pembatalan secara langsung
   - Aksi pembatalan memakai varian destructive, dan bukan aksi yang paling
     mudah ditekan tanpa sengaja

4. Keadaan sulit yang wajib dirancang
   - Pemesanan di NEEDS_REVIEW: jelaskan sedang diperiksa, kapan akan dihubungi,
     dan sediakan cara menghubungi. Jangan tampilkan seperti berhasil,
     jangan tampilkan seperti gagal
   - Pemesanan FAILED dengan refund sedang berjalan: tampilkan status refund
   - Pemesanan FAILED dengan refund selesai: tampilkan bahwa dana sudah kembali
   - Pembatalan yang refund-nya gagal: jangan sembunyikan. Jelaskan sedang
     ditangani

5. Aksesibilitas dan responsif
   - Daftar di mobile menjadi kartu, bukan tabel bergulir horizontal
   - Dialog konfirmasi mengunci fokus dan dapat ditutup dengan Escape
   - Perubahan status diumumkan lewat aria-live

Sebelum menutup step, periksa seluruh butir DESIGN-SYSTEM.md bagian 11.

Commit: feat: add bookings list and cancellation experience
```

## Definisi Selesai

- [ ] Status ditampilkan dengan kata-kata, bukan hanya warna
- [ ] Tenggat pembatalan ditampilkan sebagai tanggal dan waktu konkret
- [ ] Nilai pengembalian terlihat sebelum pengguna menekan tombol akhir
- [ ] Keadaan `NEEDS_REVIEW` punya tampilan sendiri yang jujur
- [ ] Status refund yang gagal tidak disembunyikan
- [ ] Daftar di mobile berupa kartu, bukan tabel bergulir
- [ ] Dialog konfirmasi mengunci fokus
- [ ] Seluruh butir DESIGN-SYSTEM.md bagian 11 tercentang
- [ ] Commit terbuat

## Catatan

Menampilkan tenggat sebagai "Gratis dibatalkan sampai Sabtu, 12 Okt 2026 pukul 14.00 waktu Tokyo" jauh lebih baik daripada "24 jam sebelum check-in". Kalimat kedua memaksa pengguna berhitung, dan hitungan mereka sering salah karena zona waktu.
