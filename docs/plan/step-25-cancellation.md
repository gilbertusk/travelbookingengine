# Step 25 — Pembatalan dan refund

**Fase 4** · Milestone 5 · Estimasi 7 jam · Prasyarat: Step 24 · Q3 sudah dijawab: berjenjang

## Tujuan

Menutup siklus hidup pemesanan. Memenuhi FR-27 dan G4. Pembatalan adalah saga kedua di sistem ini, dengan kompensasinya sendiri.

## Prompt

```
Implementasikan alur pembatalan dan pengembalian dana.

Baca terlebih dahulu PRD FR-27, G4, Bab 8 soal Cancellation Policy, dan
keputusan Q3.

Tulis test lebih dulu.

1. Model kebijakan pembatalan
   - Kebijakan melekat pada rate plan dan disimpan bersama pemesanan saat dibuat.
     Ini penting: kebijakan yang berlaku adalah yang disepakati saat memesan,
     bukan yang berlaku saat membatalkan
   - Keputusan Q3: pengembalian BERJENJANG dengan nilai sebagian.
     Jenjang bawaan: 100% sampai 7 hari sebelum tanggal masuk,
     50% sampai 24 jam sebelum, 0% setelahnya
   - Model kebijakan sebagai daftar jenjang terurut, bukan rangkaian
     percabangan. Jenjang dapat berbeda per rate plan
   - Perhitungan memakai allocate dari packages/money supaya tidak ada
     satuan terkecil yang hilang saat membagi
   - Jenjang yang tumpang tindih atau tidak terurut ditolak saat validasi,
     bukan diselesaikan diam-diam
   - Tenggat dihitung terhadap tanggal masuk dengan zona waktu properti,
     bukan zona waktu pengguna dan bukan UTC. Lihat CONVENTIONS.md bagian 9

2. Saga pembatalan
   Langkah:
   1. Validasi kelayakan: keadaan pemesanan, tenggat kebijakan
   2. Hitung nilai pengembalian
   3. Batalkan di supplier lewat perintah supplier.cancel
   4. Proses refund lewat perintah payment.refund
   5. Pindahkan pemesanan ke CANCELLED

   Kompensasi:
   - Bila pembatalan di supplier berhasil tetapi refund gagal permanen:
     JANGAN membatalkan pembatalan supplier. Pindahkan ke NEEDS_REVIEW dengan
     galat tingkat error. Uang pengguna tertahan dan ini butuh manusia
   - Bila pembatalan di supplier gagal: jangan lakukan refund. Kamar masih
     terpesan, mengembalikan uang berarti kerugian ganda

3. Pratinjau pembatalan
   - Endpoint yang menghitung nilai pengembalian tanpa melakukan apa pun
   - Dipakai frontend untuk menampilkan konsekuensi sebelum pengguna memutuskan
   - Pengguna harus tahu berapa yang kembali SEBELUM menekan tombol

4. Idempotency
   - Permintaan pembatalan berulang tidak menghasilkan refund ganda
   - Ditegakkan lewat batasan unik

5. Endpoint
   - GET  /bookings/:id/cancellation-preview
   - POST /bookings/:id/cancel

Test yang wajib:
- Perhitungan pengembalian benar untuk setiap jenjang kebijakan
- Tenggat dihitung dengan zona waktu properti — uji dengan properti di
  zona waktu berbeda
- Kebijakan yang dipakai adalah yang tersimpan saat memesan, bukan yang terbaru
- Pembatalan setelah tenggat menghasilkan pengembalian nol dengan penjelasan jelas
- Refund gagal setelah pembatalan supplier berhasil: NEEDS_REVIEW, bukan diam
- Pembatalan supplier gagal: tidak ada refund yang dijalankan
- Pembatalan berulang tidak menghasilkan refund ganda

Commit: feat: add cancellation and refund flow
```

## Definisi Selesai

- [x] Kebijakan yang berlaku adalah yang tersimpan saat memesan. Jadwal pengembalian disimpan di `refund_schedule` setiap kali harga diverifikasi, dan pembatalan tidak menurunkannya ulang. Uji: rate plan yang sesudahnya menjadi non-refundable tidak mengubah pemesanan yang sudah ada.
- [x] Tenggat dihitung dengan zona waktu properti, dibuktikan dengan uji lintas zona. Contoh di Catatan diuji apa adanya: pukul 23.00 WIB memberi 0% untuk hotel di Tokyo dan 50% untuk hotel di Jakarta. Uji domain mencakup pergantian jam musim panas, tengah malam yang tidak ada (Santiago), dan tanggal yang dilompati (Samoa 2011).
- [x] Pratinjau menampilkan nilai pengembalian sebelum pengguna memutuskan. `GET /bookings/:id/cancellation-preview` menyebut nilai, persentase, dan seluruh tenggat sebagai titik waktu bersama zona properti. `POST /bookings/:id/cancel` wajib membawa nilai yang dilihat itu; bila jenjangnya sudah berganti, jawabannya 409 dengan pratinjau baru dan tidak ada yang dibatalkan.
- [x] Refund gagal setelah pembatalan supplier berhasil menghasilkan `NEEDS_REVIEW`, dengan galat tingkat error, dan pembatalan supplier tidak dibalik.
- [x] Pembatalan supplier gagal tidak memicu refund. Penolakan supplier mengembalikan pemesanan ke CONFIRMED; status yang tidak pasti ke NEEDS_REVIEW.
- [x] Pembatalan berulang tidak menghasilkan refund ganda: permintaan serentak, jawaban supplier ganda, dan permintaan ulang menghasilkan satu `supplier.cancel` dan satu `payment.refund`. Pengenal refund deterministik dijaga batasan UNIK `request_id` di payment-service.
- [x] Keputusan Q3 tercatat sebagai ADR: [ADR-0004](../adr/0004-pembatalan-berjenjang.md).
- [x] Cakupan test ≥ 85%. booking-service 96%; `application/cancellation/**` dan `domain/cancellation-handlers.ts` 100% (ambang baru, sama dengan jalur kompensasi saga Step 19).
- [x] Commit terbuat

## Temuan

### Kebijakan dari peramban menentukan uang

Sejak Step 23, kebijakan pembatalan masuk dari hasil pencarian yang dikirim ulang peramban, dan hanya bentuknya yang diperiksa. Untuk voucher itu tercatat sebagai utang; untuk refund itu celah uang. Pengguna dapat memesan rate non-refundable yang lebih murah, mengirim `refundable: true`, lalu membatalkannya dengan refund penuh.

Keputusan (dipilih pengguna): price check supplier kini wajib membawa `cancellationPolicy`. Kelima adapter dan kelima endpoint mock-supplier diperluas. Kebijakan peramban hanya dicatat bila berbeda; yang menentukan uang dan yang dicetak voucher adalah jawaban supplier. Utang Step 23 "ketentuan tawaran tidak diverifikasi" tertutup untuk kebijakan pembatalan; nama kamar dan rate plan tetap dari peramban.

### CONFIRMED final, dan tetap final

Step 16 mencatat bahwa uji finalitas dua arah akan menabrak Step 25. Penyelesaiannya ada di ADR-0004: keadaan final kini berarti "tanpa transisi keluar yang dijalankan sistem". CONFIRMED mendapat satu transisi milik pengguna (`requestCancellation`, didaftar di `USER_INITIATED_COMMANDS`), dan uji finalitas tetap dua arah atas transisi sistem.

### Dua jawaban yang tidak pernah ada

`supplier.cancel` dan `payment.refund` sebelumnya tidak punya jalan balik ke saga. Keduanya kini menerbitkan peristiwa: `supplier.booking_cancelled` / `supplier.booking_cancel_failed` dari supplier-service, dan `payment.refund_failed` dari dead letter payment-service.

### Temuan code review yang diperbaiki

- **Dead letter `supplier.cancel` diumumkan sebagai penolakan pasti.** Batas waktu di setiap percobaan dapat berarti pembatalannya sudah terjadi, tetapi pemesanan dikembalikan ke CONFIRMED. Sekarang `supplier.booking_cancel_failed` membawa `outcome`: `refused` hanya untuk jawaban 4xx dari supplier, selain itu `uncertain`, yang berakhir di NEEDS_REVIEW tanpa refund.
- **Peninjauan dari CANCELLING kehilangan booking reference dan nilai yang disetujui.** Sekarang keduanya ditulis ke alasan peninjauan.
- **Refund yang berhasil tetapi pengumumannya gagal terbit tidak pernah diumumkan ulang.** Saga pembatalan akan menunggu sampai batas waktunya dan menyerahkan refund yang sudah tuntas ke manusia. Sekarang perintah ulang untuk refund yang sudah berhasil mengumumkannya lagi.
- **Tanggal yang dilompati zona waktunya** (Samoa, 30 Desember 2011) menghasilkan `Invalid Date` dan galat 500. Sekarang dijawab sebagai zona yang tidak dapat dihitung.

### Verifikasi

Sebelum commit: lint, typecheck, format, build, enam skrip verifikasi, dan seluruh uji unit hijau (booking-service 933). Uji integrasi hijau: booking-service 67 (termasuk CHECK baru, pulang-pergi keadaan pembatalan, dan kueri penyapu terhadap Postgres sungguhan), voucher-service 6, notification-service 12. Rangkaian saga: 11 dari 14 lulus pada jalan penuh. Pekerja `supplier-uncertainty.test.ts` mati dengan kode 3221226505 (0xC0000409) yang sama dengan Step 20 dan 22, lalu ketiga ujinya lulus saat dijalankan ulang sendiri.

### Utang

- Refund yang ditolak sebagai `not_refundable` atau `already_failed` tidak diumumkan `payment.refund_failed`. Pembatalan seperti itu baru sampai ke NEEDS_REVIEW setelah batas waktu refund (15 menit).
- Pembatalan setelah tanggal masuk dimulai ditolak (`stay_started`); kebijakan no-show tidak dimodelkan.
- Pemesanan sebelum Step 25 tidak punya jadwal dan diserahkan ke manusia (`policy_unknown`).
- Saga pembatalan belum masuk rangkaian uji saga ujung ke ujung (tests/saga) maupun uji beban.
- Layar pembatalan menyusul di Step 26. Step 25 hanya membuat layar status yang ada tidak berbohong untuk CANCELLING dan pembatalan oleh pengguna.

## Catatan

Zona waktu properti adalah jebakan yang nyata. Pemesan di Jakarta membatalkan hotel di Tokyo pada pukul 23.00 waktu Jakarta, dan mengira masih di dalam tenggat 24 jam. Di Tokyo sudah lewat. Tanpa penanganan zona waktu properti, sistem akan salah menghitung dan salahnya selalu merugikan salah satu pihak.
