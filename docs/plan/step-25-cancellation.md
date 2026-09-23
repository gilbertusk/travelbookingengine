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

- [ ] Kebijakan yang berlaku adalah yang tersimpan saat memesan
- [ ] Tenggat dihitung dengan zona waktu properti — dibuktikan dengan test lintas zona
- [ ] Pratinjau menampilkan nilai pengembalian sebelum pengguna memutuskan
- [ ] Refund gagal setelah pembatalan supplier berhasil menghasilkan `NEEDS_REVIEW`
- [ ] Pembatalan supplier gagal tidak memicu refund
- [ ] Pembatalan berulang tidak menghasilkan refund ganda
- [ ] Keputusan Q3 tercatat sebagai ADR
- [ ] Cakupan test ≥ 85%
- [ ] Commit terbuat

## Catatan

Zona waktu properti adalah jebakan yang nyata. Pemesan di Jakarta membatalkan hotel di Tokyo pada pukul 23.00 waktu Jakarta, dan mengira masih di dalam tenggat 24 jam. Di Tokyo sudah lewat. Tanpa penanganan zona waktu properti, sistem akan salah menghitung dan salahnya selalu merugikan salah satu pihak.
