# Step 23 — voucher-service

**Fase 4** · Milestone 5 · Estimasi 4 jam · Prasyarat: Step 22

## Tujuan

Menerbitkan bukti pemesanan yang sah. Memenuhi FR-24 dan M7, sekaligus menjadi contoh consumer RabbitMQ untuk pekerjaan berat yang tidak boleh membuat pengguna menunggu.

## Prompt

```
Buat apps/voucher-service.

Baca terlebih dahulu PRD FR-24, M7, dan docs/plan/CONVENTIONS.md.

Tulis test lebih dulu.

1. Consumer
   - Mengonsumsi perintah voucher.generate dari RabbitMQ
   - Idempoten: perintah yang sama tidak menghasilkan voucher ganda.
     Bila voucher untuk bookingId sudah ada, kembalikan yang lama
   - Kegagalan mengikuti retry berjenjang, lalu dead letter

2. Pembuatan PDF
   - Memakai PDFKit
   - Isi wajib: booking reference dari supplier, nama properti dan alamat,
     tanggal masuk dan keluar, jenis kamar, nama tamu, jumlah tamu,
     rincian harga, kebijakan pembatalan, dan kontak properti
   - Kode QR berisi booking reference
   - Tata letak mengikuti arah visual DESIGN-SYSTEM.md: tenang, tipografi jelas,
     tanpa hiasan berlebihan. Voucher yang dicetak harus tetap terbaca
     dalam hitam putih
   - Ukuran A4, dan pastikan teks tidak terpotong untuk nama properti panjang

3. Penyimpanan
   - Unggah ke MinIO di bucket vouchers
   - Kunci objek tidak boleh dapat ditebak. Jangan memakai bookingId mentah
   - Simpan metadata di database: bookingId, objectKey, issuedAt, sizeBytes

4. Akses
   - GET /vouchers/:bookingId menghasilkan URL bertanda tangan berumur pendek
   - Hanya pemilik pemesanan yang boleh mengakses. Periksa kepemilikan,
     jangan hanya mengandalkan ketidaktahuan URL
   - Pemesanan yang belum CONFIRMED tidak punya voucher, dan endpoint
     mengembalikan galat yang jelas

5. Peristiwa
   - Setelah voucher terbit, terbitkan peristiwa agar notification-service
     dapat mengirimkannya
   - Ukur selisih waktu dari booking.confirmed sampai voucher terbit
     sebagai metrik, untuk membuktikan M7

Test yang wajib:
- Perintah yang sama dua kali menghasilkan satu voucher
- PDF berisi seluruh field wajib — periksa dengan mengekstrak teks dari PDF
- Nama properti yang sangat panjang tidak membuat teks terpotong
- Pengguna lain tidak dapat mengakses voucher milik orang lain
- Pemesanan belum CONFIRMED menghasilkan galat yang jelas

Commit: feat: add voucher service
```

## Definisi Selesai

- [ ] Consumer idempoten, perintah ganda tidak menghasilkan voucher ganda
- [ ] PDF memuat seluruh field wajib, diverifikasi dengan ekstraksi teks
- [ ] Voucher terbaca dalam cetakan hitam putih
- [ ] Kunci objek tidak dapat ditebak
- [ ] Kepemilikan diperiksa, bukan hanya mengandalkan URL rahasia
- [ ] URL bertanda tangan berumur pendek
- [ ] M7 tercapai: p95 di bawah 30 detik dari konfirmasi sampai voucher terbit
- [ ] Cakupan test ≥ 80%
- [ ] Commit terbuat

## Catatan

Memeriksa kepemilikan meskipun URL sudah bertanda tangan adalah lapisan kedua yang sering dilewati. URL bisa bocor lewat riwayat peramban, log proksi, atau dibagikan tanpa sengaja.
