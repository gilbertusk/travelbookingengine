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

- [x] Hitung mundur hold disinkronkan dengan waktu server, bukan jam lokal — booking-service kini mengirim `serverTime` di setiap jawaban. Selisihnya dihitung sekali terhadap titik tengah permintaan (`clockOffset`), lalu dipertahankan
- [x] Dialog perubahan harga bernada tenang, bukan alarm, dan mengunci fokus — tanpa merah, tanpa peran `alert`. Harga lama, harga baru, dan selisih bertanda kata ("naik"/"turun"). Fokus dikunci dan Escape menutup lewat Radix. Menutup bukan menolak: halaman menyediakan "Tinjau harga baru"
- [x] Perubahan harga berulang ditangani tanpa merusak keadaan — persetujuan yang dijawab "berubah lagi" membuka dialog dengan angka baru (kunci komponen berganti). Diuji di flow-controller.test.ts
- [x] Status pemesanan diperbarui langsung lewat SSE — lewat `fetch` dan pengurai sendiri, bukan `EventSource`, karena token akses hanya ada di memori. Diperiksa di peramban: PAID → CONFIRMED tanpa muat ulang
- [x] SSE menyambung ulang otomatis dan punya cadangan polling — jeda 1, 2, 5 detik; polling setiap 3 detik setelah tiga kegagalan beruntun; berhenti di `event: end` atau keadaan final
- [x] Keadaan gagal menjelaskan status dana dengan bahasa manusia — setiap keadaan setelah pembayaran membawa kalimat tentang uang pengguna; `failureReason` dari server tidak pernah tampil
- [x] Keadaan `NEEDS_REVIEW` punya tampilan sendiri yang jujur — "sedang kami periksa", tanpa kata berhasil, gagal, atau terkonfirmasi. Janji waktu `1×24 jam` adalah asumsi; lihat Temuan
- [x] Tidak ada layar buntu tanpa aksi — diuji per keadaan di booking-pages.test.tsx
- [~] Seluruh alur dapat diselesaikan dengan keyboard saja — **sebagian.** Formulir, dialog (fokus dan Escape), dan tombol diuji dengan `userEvent`; urutan tab di peramban belum ditelusuri dari awal sampai akhir. Popup Snap milik Midtrans, di luar kendali kita
- [x] Tampilan benar pada lebar 375px, aksi utama menempel di bawah — diperiksa di peramban (halaman pemesanan dan status, build produksi): `scrollWidth` = `clientWidth`, tidak ada elemen yang melewati 375px
- [x] Seluruh butir DESIGN-SYSTEM.md bagian 11 tercentang — lihat di bawah
- [x] Commit terbuat — `feat: add booking flow experience`

### DESIGN-SYSTEM.md bagian 11

- [x] Tidak ada nilai warna mentah — `pnpm verify:tokens`. Skrip ini menangkap dua jarak `0.5` di luar skala, dan keduanya sudah diperbaiki
- [x] Tidak ada jarak di luar skala 4px — skrip yang sama
- [x] Empat keadaan untuk setiap tampilan yang mengambil data — halaman pemesanan (properti), halaman status (status dan rincian terpisah), dan kembalian Snap
- [~] Bisa dioperasikan penuh dengan keyboard — lihat butir di atas
- [x] Kontras memenuhi AA — `pnpm verify:contrast`, 30 pasangan. Hitung mundur bernada peringatan memakai latar `warning/10` dengan teks `foreground`, bukan teks kuning
- [x] Terlihat benar pada 375px
- [x] `prefers-reduced-motion` dihormati — tidak ada gerak baru selain animasi dialog Radix yang sudah ada. Hitung mundur dan tahap yang sedang berjalan sengaja tidak beranimasi
- [x] Tidak ada kartu bersarang
- [x] Warna aksen untuk satu aksi utama per layar — "Lanjutkan ke pembayaran", "Terima harga baru", "Bayar", "Buka pembayaran lagi". Penanda tahap yang sedang berjalan memakai warna `foreground`, bukan aksen

## Catatan

Menyinkronkan hitung mundur dengan waktu server terdengar berlebihan sampai ada pengguna yang jam komputernya meleset lima menit dan melihat hold-nya habis padahal masih ada waktu. Hitung selisih waktu sekali saat halaman dimuat, lalu pakai selisih itu.

## Bukti

### Uji

- apps/web: **381 uji**. Cakupan seluruh paket 92% baris, 84% cabang (ambang 80/75). Yang baru:
  - `features/booking`: hitung mundur dan selisih jam, pengurai SSE dan pengamatan (sambung ulang, polling, 401), keputusan alur, pengendali alur ujung ke ujung dengan I/O palsuan, Snap, pilihan kamar lewat URL, kalimat status
  - `components/booking`: komponen dan halaman, satu uji per keadaan
- booking-service: **683 uji unit** (dari 657) dan **56 uji integrasi** terhadap Testcontainers. Yang baru: `POST /bookings/:id/payment`, adapter payment-service, `serverTime`
- payment-service: 251 uji; `snapToken` di jawaban maksud pembayaran
- Seluruh perintah verifikasi hijau: `build`, `lint`, `typecheck`, `format:check`, `test`, `verify:*`

### Peramban

Build produksi `apps/web`, dengan gateway palsu di port 4001 yang menjawab dalam bentuk booking-service (skrip di luar repo). Alur yang dijalani dengan tangan:

1. Formulir tamu: galat surel muncul saat blur, tidak saat mengetik.
2. Price check dijawab "berubah": dialog muncul dengan Rp 2.442.000 → Rp 2.600.000, "naik Rp 158.000".
3. Harga diterima → hold → hitung mundur.
4. Bayar dijawab 503: layar galat dengan "Coba lagi" dan "Kembali ke properti". Pemeriksaan ini menemukan cacat: hitung mundurnya hilang. Lihat Temuan.
5. Halaman status: PAID, lalu CONFIRMED lewat SSE empat detik kemudian, tanpa muat ulang.

Tidak ada galat di konsol. Pada 375px kedua halaman tanpa luapan mendatar. Halaman diperiksa di iframe selebar 375px lewat proxy yang membuang `X-Frame-Options`, karena jendela peramban tidak dapat diperkecil dan header itu memang menolak iframe.

**Yang BELUM diperiksa:** popup Snap sungguhan. Untuk itu dibutuhkan client key dan server key sandbox Midtrans, dan keduanya tidak ada di mesin ini. Alur lengkap terhadap service yang berjalan juga belum diperiksa: gateway, auth, search, booking, payment, dan supplier sekaligus.

## Temuan

### Blokir yang tidak disebut: tidak ada pintu pengguna ke pembayaran

Step 18 membuat `POST /internal/payments` di payment-service, tetapi tidak ada jalan bagi peramban untuk sampai ke sana:

- api-gateway meneruskan `/payments/*` dengan path apa adanya, sedangkan payment-service tidak punya rute `/payments`.
- payment-service tidak mengenal pemilik pemesanan. Menerbitkan rutenya berarti siapa pun dapat membuka pembayaran untuk pemesanan orang lain.

Diputuskan di step ini, tanpa bertanya, karena alternatifnya menghentikan seluruh step: **pintunya di booking-service**, `POST /bookings/:id/payment`. Hanya booking-service yang tahu pemiliknya, keadaan HELD-nya, dan batas hold-nya. booking-service lalu memanggil payment-service secara internal. Rute `/payments` di api-gateway kini tidak dipakai, dan begitu pula `/payments/webhook` — webhook memang tidak lewat gateway (README payment-service). Membersihkan keduanya adalah pekerjaan Step 30.

Keputusan ini perlu ditinjau pemilik proyek. Biayanya: booking-service bergantung pada payment-service secara sinkron untuk satu rute.

### Token Snap tidak pernah dikembalikan

payment-service menyimpan token Snap sebagai `providerRef`, tetapi hanya mengembalikan `redirectUrl`. Popup Snap — yang direkomendasikan step doc ini — membutuhkan tokennya. Kini keduanya dikembalikan.

### `EventSource` tidak dapat dipakai

Token akses sengaja hanya ada di memori (Step 09), sedangkan `EventSource` tidak dapat mengirim header `Authorization`. Aliran dibaca lewat `fetch`, dengan pengurai SSE sendiri yang diuji: peristiwa yang terbelah jaringan, CRLF, dan data bertingkat. Pilihan lainnya — token di kueri URL — menaruh token di log proxy mana pun.

### Login memutus alur pemesanan

`proxy.ts` membawa `pathname` ke halaman masuk, tetapi tanpa kuerinya. Pengguna yang belum masuk dan memilih kamar akan kembali ke `/bookings/pesan` tanpa pilihan kamar. Kini kuerinya ikut.

### Cacat yang ditemukan sendiri

- **Melanjutkan setelah dimuat ulang langsung gagal.** Pemesanan yang masih menunggu price check ulang dianggap "sudah dicek ulang", sehingga masuk ke layar galat alih-alih meminta data tamu lagi. Ditemukan uji pengendali.
- **Hitung mundur hilang saat pembayaran gagal dibuka.** Ditemukan di peramban. Kamar masih tertahan, tetapi pengguna tidak lagi melihat sisa waktunya. Kini tetap tampil di layar galat pembayaran.
- **Hook alur melanggar aturan ref React.** Versi pertama berupa satu hook dengan langkah-langkah yang saling memanggil lewat ref, dan lint React menolaknya. Alurnya dipindah ke kelas di luar React (`flow-controller.ts`) yang dilanggani lewat `useSyncExternalStore`. Hasilnya, seluruh alur dapat diuji tanpa merender.

### Keputusan yang dicatat

- **Data tamu tidak disimpan di peramban.** Yang disimpan di sessionStorage hanyalah kunci idempotensi, nama properti untuk halaman status, dan pemesanan yang sedang dibayar.
- **Harga tidak dibawa URL.** Halaman pemesanan mengambil ulang tawaran dari pencarian. Harga yang dikirim ke price check adalah harga yang dilihat pengguna di halaman itu, bukan angka dari URL yang dapat diubah siapa pun.
- **Popup Snap yang ditutup tidak memindahkan pengguna.** Pengguna tetap di halaman pemesanan dengan kamar yang masih tertahan. Halaman status menangani kembalian Snap halaman penuh: sukses, tertunda, gagal, dan ditutup.

### Asumsi yang perlu dikonfirmasi

- **Janji waktu peninjauan `1×24 jam`** (`REVIEW_CONTACT_WITHIN`). PRD tidak menetapkannya, dan kalimat itu janji kepada pengguna. Harus dikonfirmasi pemilik proyek sebelum peluncuran.

### Utang

- **Voucher (Step 23).** Tahap "Voucher diterbitkan" berhenti di "sedang disiapkan", dan tombol "Unduh voucher" dinonaktifkan dengan penjelasan. Tidak ada sinyal penerbitan voucher yang dapat dibaca halaman ini sampai voucher-service ada.
- **Nama properti di halaman status** hanya tersedia bila halaman dibuka dari alur pemesanan di tab yang sama. Selain itu yang tampil "Penginapan di {kota}", karena booking-service menyimpan pengenal properti versi supplier, bukan namanya.
- **Batas waktu gateway untuk `/bookings` 10 detik.** Membuka pembayaran melewati booking-service, lalu payment-service, lalu Midtrans. Batas itu belum diukur terhadap Midtrans sandbox.
