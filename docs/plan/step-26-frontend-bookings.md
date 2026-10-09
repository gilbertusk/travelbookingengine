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

- [x] Status ditampilkan dengan kata-kata, bukan hanya warna. `statusOf` memberi setiap keadaan label tertulis, dan diuji untuk seluruh sebelas keadaan. Lencana warnanya hanya mengulang arti kata-katanya.
- [x] Tenggat pembatalan ditampilkan sebagai tanggal dan waktu konkret di zona properti, misalnya "Gratis dibatalkan sampai Jumat, 6 Nov 2026 pukul 23.59 WITA". Zona Indonesia memakai WIB/WITA/WIT; zona lain disebut "waktu Tokyo", bukan "GMT+9".
- [x] Nilai pengembalian terlihat sebelum pengguna menekan tombol akhir: di bagian kebijakan ("Bila dibatalkan sekarang…") dan di dialog (dana yang kembali, yang hangus, perkiraan sampai). Nilai itu pula yang dikirim sebagai `expectedRefund`; bila jenjangnya berganti, tidak ada yang dibatalkan dan nilai baru dimuat.
- [x] Keadaan `NEEDS_REVIEW` punya tampilan sendiri yang jujur, dengan kapan kami menghubungi dan alamat bantuan (`NEXT_PUBLIC_SUPPORT_EMAIL`). Pemeriksaan pembatalan punya kalimatnya sendiri.
- [x] Status refund yang gagal tidak disembunyikan. Pembatalan yang refundnya gagal tampil sebagai "Pembatalan sedang diperiksa" di daftar dan di halaman status.
- [x] Daftar di mobile berupa kartu, bukan tabel bergulir. Diperiksa di 375px: `scrollWidth` halaman 375 untuk daftar, detail, dan dialog.
- [x] Dialog konfirmasi mengunci fokus (Radix), fokus awalnya pada "Jangan batalkan", dan dapat ditutup dengan Escape. Diuji.
- [x] Seluruh butir DESIGN-SYSTEM.md bagian 11 tercentang (lihat Temuan).
- [x] Commit terbuat

## Temuan

### Backend yang dibutuhkan layar ini

- `GET /bookings?group=upcoming|past|cancelled&cursor=&limit=`. Kelompok dinyatakan di domain (`booking-groups.ts`) dan sebagai kueri di repository; satu uji memastikan keduanya sepakat untuk setiap keadaan. Pemesanan yang masih berproses (menunggu bayar, menunggu supplier, sedang dibatalkan, diperiksa) selalu di "akan datang", apa pun tanggalnya. DRAFT dan PRICE_CHECKED tidak pernah tampil.
- Halaman berupa offset di balik penunjuk buram. Pemesanan yang berpindah kelompok di antara dua halaman dapat terlewat atau terulang satu kali.
- Nama properti dari katalog search-service (`PropertyDirectory.lookup`, yang juga memberi zona waktu Step 25), sekali per properti per halaman. Katalog yang tidak menjawab tidak menggagalkan daftar: entri tampil dengan kotanya.
- `GET /bookings/:id` kini membawa `propertyName`, `supplierRef`, dan ketentuan tawaran versi supplier.
- Indeks baru `bookings(user_id, check_in)`.

### Bagian 11 DESIGN-SYSTEM.md

- Tidak ada warna mentah (`verify:tokens`, `verify:contrast` hijau). Jarak memakai skala Tailwind 4px.
- Empat keadaan untuk daftar (per kelompok), pratinjau pembatalan, dan rincian; masing-masing diuji.
- Keyboard: kartu adalah satu tautan dengan `focus-visible`; tab, dialog, dan tombol voucher dapat dioperasikan penuh.
- 375px diperiksa lewat tangkapan layar Chromium headless (build produksi, gateway palsu di luar repo).
- Gerak memakai transisi warna token yang sudah menghormati `prefers-reduced-motion`. Tidak ada kartu bersarang. Aksen tidak dipakai di halaman detail selain status keberhasilan; tombol pembatalan bervarian sekunder, tombol akhirnya destructive.

### Utang

- Tanggal "hari ini" untuk kelompok adalah tanggal UTC, bukan tanggal di properti; batas "selesai" bisa bergeser satu hari di sekitar tengah malam.
- Tautan voucher dibuka di tab yang sama.
- Belum ada uji ujung ke ujung (Playwright) terhadap seluruh service yang berjalan.

## Catatan

Menampilkan tenggat sebagai "Gratis dibatalkan sampai Sabtu, 12 Okt 2026 pukul 14.00 waktu Tokyo" jauh lebih baik daripada "24 jam sebelum check-in". Kalimat kedua memaksa pengguna berhitung, dan hitungan mereka sering salah karena zona waktu.
