# Step 17 — Hold dan price check

**Fase 3** · Milestone 4 · Estimasi 5 jam · Prasyarat: Step 16

## Tujuan

Dua mekanisme yang mencegah dua kelas masalah berbeda: hold mencegah penjualan melebihi ketersediaan, price check mencegah pengguna dibebani harga yang tidak disetujuinya. Keduanya memenuhi FR-13 sampai FR-16 dan G2.

## Prompt

```
Implementasikan mekanisme hold dan price check di apps/booking-service.

Baca terlebih dahulu PRD FR-13 sampai FR-16, US-02, US-04, dan Bab 2.2 masalah 2.

Tulis test lebih dulu.

1. Price check (FR-13, FR-14, US-02)
   - Sebelum meminta pembayaran, verifikasi harga langsung ke supplier lewat
     supplier-service. TIDAK BOLEH dilayani dari cache, tanpa pengecualian
   - Hasilnya berupa union diskriminan:
     unchanged  -> lanjut ke hold
     changed    -> hentikan alur, kembalikan harga lama dan baru beserta selisih,
                   terbitkan booking.price_changed, tunggu persetujuan eksplisit
     unavailable-> hentikan alur dengan pesan yang jelas
   - Persetujuan harga baru menghasilkan permintaan price check ulang.
     Harga bisa berubah lagi, dan sistem harus tahan terhadap itu
   - Simpan harga yang disetujui pengguna. Pembebanan pembayaran WAJIB memakai
     nilai ini, bukan nilai lain mana pun

2. Hold (FR-15, FR-16)
   Dua lapis, keduanya diperlukan:

   Lapis lokal — Redis:
   - Kunci per rate plan per rentang tanggal
   - Skrip Lua untuk pemeriksaan dan pengurangan secara atomik. Ini yang
     menjamin US-04: pada M permintaan serentak untuk N ketersediaan,
     tepat N yang berhasil
   - TTL sesuai durasi hold
   - Jangan memakai pola baca lalu tulis. Harus satu operasi atomik

   Lapis supplier:
   - Panggil operasi hold supplier lewat supplier-service
   - Simpan token hold dan waktu kedaluwarsanya
   - Waktu kedaluwarsa yang dipakai sistem adalah yang lebih awal antara
     kedaluwarsa lokal dan kedaluwarsa supplier

3. Pelepasan hold otomatis
   - Manfaatkan keyspace notification Redis untuk kunci yang kedaluwarsa
   - Saat hold lokal kedaluwarsa: lepaskan hold di supplier, pindahkan
     pemesanan ke EXPIRED, terbitkan peristiwa
   - Sediakan juga pekerjaan penyapu berkala sebagai jaring pengaman, karena
     keyspace notification tidak menjamin pengiriman. Penyapu harus idempoten
   - Dua jalur ini tidak boleh saling merusak bila berjalan bersamaan

4. Idempotency (FR-18)
   - Permintaan pemesanan membawa idempotency key dari klien
   - Kunci yang sama mengembalikan pemesanan yang sama, tidak membuat yang baru
   - Ditegakkan lewat batasan unik di database, bukan hanya pemeriksaan di aplikasi.
     Pemeriksaan di aplikasi punya celah balapan

5. Endpoint
   - POST /bookings/price-check
   - POST /bookings/price-check/accept
   - POST /bookings/hold
   - GET  /bookings/:id

Test yang wajib:
- Price check tidak pernah menyentuh cache — dibuktikan dengan test
- Harga berubah menghentikan alur dan menerbitkan peristiwa yang benar
- Pembebanan selalu memakai harga yang terakhir disetujui
- Seratus permintaan hold serentak untuk ketersediaan sepuluh: tepat sepuluh berhasil
- Hold kedaluwarsa melepaskan hold supplier dan memindahkan keadaan ke EXPIRED
- Penyapu berkala idempoten dan aman dijalankan bersamaan dengan jalur keyspace
- Idempotency key yang sama tidak menghasilkan pemesanan kedua, dibuktikan
  dengan dua permintaan serentak

Commit: feat: add hold mechanism and price check
```

## Definisi Selesai

- [ ] Price check selalu langsung ke supplier, tidak pernah dari cache
- [ ] Alur berhenti dan meminta persetujuan ketika harga berubah
- [ ] Pembebanan memakai harga yang disetujui, dibuktikan dengan test
- [ ] Pengurangan ketersediaan atomik lewat skrip Lua
- [ ] Seratus permintaan serentak untuk ketersediaan sepuluh menghasilkan tepat sepuluh
- [ ] Hold terlepas otomatis saat kedaluwarsa, baik lewat keyspace maupun penyapu
- [ ] Idempotency ditegakkan lewat batasan unik database
- [ ] Cakupan test ≥ 85%
- [ ] Commit terbuat

## Catatan

Jaring pengaman berupa penyapu berkala sering dianggap mubazir karena keyspace notification "biasanya jalan". Redis tidak menjamin pengiriman notifikasi kepada klien yang sedang terputus. Tanpa penyapu, hold yatim akan menahan inventaris selamanya — dan itu baru ketahuan saat demo.
