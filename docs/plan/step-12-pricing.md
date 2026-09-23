# Step 12 — Package money dan pricing-service

**Fase 2** · Milestone 3 · Estimasi 5 jam · Prasyarat: Step 11 · Q2 sudah dijawab: IDR dan USD

## Tujuan

Menangani uang dengan benar sejak awal. NFR-08 melarang aritmetika pecahan biner untuk nilai uang, dan sekali kesalahan ini masuk, ia menyebar ke seluruh sistem dan hanya ketahuan saat rekonsiliasi tidak pernah cocok.

## Prompt

```
Buat packages/money dan apps/pricing-service.

Baca docs/plan/CONVENTIONS.md bagian 9, serta PRD NFR-08 dan FR-05 terlebih dahulu.

Tulis test lebih dulu, terutama untuk pembulatan dan konversi.

=== packages/money ===

Pembungkus tipis di atas dinero.js v2.

- Tipe Money yang selalu membawa jumlah dalam satuan terkecil dan kode mata uangnya.
  Tidak boleh ada nilai uang tanpa mata uang
- Operasi: add, subtract, multiply, allocate, compare, isZero, isNegative
- Operasi antar mata uang berbeda menghasilkan galat pada tingkat tipe bila mungkin,
  dan galat saat jalan bila tidak
- Pembulatan dinyatakan eksplisit sebagai argumen, tidak ada bawaan tersembunyi
- Pemformatan untuk tampilan sesuai lokal, terpisah dari perhitungan
- Serialisasi ke JSON dan kembali, untuk disimpan di database dan dikirim lewat pesan
- Helper untuk Prisma: simpan sebagai integer satuan terkecil ditambah kolom
  mata uang. JANGAN memakai tipe float atau double di skema mana pun

Test yang wajib:
- Penjumlahan berulang tidak menghasilkan galat pembulatan
- allocate membagi tanpa kehilangan satu satuan terkecil pun
- Operasi lintas mata uang ditolak
- Round trip serialisasi tidak mengubah nilai

=== apps/pricing-service ===

Mengubah harga supplier menjadi harga jual akhir.

1. Domain
   - Aturan markup: persentase atau nominal tetap, berlaku per supplier,
     per kota, atau global, dengan prioritas yang jelas dan dapat diuji
   - Perhitungan pajak
   - Konversi mata uang
   - Urutan perhitungan dinyatakan eksplisit dan diuji: harga supplier ->
     konversi mata uang -> markup -> pajak -> pembulatan akhir
   - Pembulatan hanya sekali, di akhir

2. Nilai tukar
   - Tabel exchange_rates dengan waktu berlaku
   - Kurs di-cache di Redis dengan TTL
   - Keputusan Q2: dukung dua mata uang saja, IDR dan USD. Jangan membuat
     abstraksi untuk mata uang yang belum dibutuhkan
   - Perhatikan IDR tidak punya satuan pecahan yang dipakai sehari-hari
     sementara USD punya dua desimal. Pembulatan untuk keduanya berbeda,
     dan ini wajib diuji
   - Sumber kurs boleh statis untuk MVP, tapi antarmukanya dibuat seolah dari luar

3. Aturan markup
   - Tabel markup_rules dengan prioritas
   - Operasi CRUD untuk operator (FR-30), dilindungi peran operator
   - Perubahan aturan tidak boleh mengubah harga pemesanan yang sudah terjadi

4. Antarmuka
   - HTTP internal: priceRatePlans menerima daftar rate plan kanonik dan
     mengembalikan harga akhir beserta rinciannya
   - Rincian harga wajib dikembalikan: harga dasar, kurs yang dipakai, markup,
     pajak, total. Ini dibutuhkan untuk FR-05 dan untuk transparansi biaya
     yang diwajibkan DESIGN-SYSTEM.md pada komponen PriceDisplay

5. Performa
   - Operasi ini berada di jalur kritis pencarian. Harus mampu memproses
     ratusan rate plan dalam satu panggilan tanpa query per item
   - Kurs dan aturan markup dimuat sekali per panggilan, bukan per rate plan

Test yang wajib:
- Urutan perhitungan benar dan hasilnya sesuai contoh yang dihitung manual
- Prioritas aturan markup diterapkan dengan benar
- Memproses 500 rate plan tidak menghasilkan query berulang

Commit: feat: add money package and pricing service
```

## Definisi Selesai

- [ ] Tidak ada satu pun nilai uang bertipe `number` di seluruh repo
- [ ] Tidak ada kolom `float` atau `double` di skema Prisma mana pun
- [ ] Penjumlahan berulang tidak menghasilkan galat pembulatan — dibuktikan dengan test
- [ ] Operasi lintas mata uang ditolak
- [ ] Urutan perhitungan dinyatakan eksplisit dan diuji terhadap contoh manual
- [ ] Rincian harga dikembalikan lengkap, bukan hanya total
- [ ] Memproses 500 rate plan tidak menghasilkan query per item
- [ ] Keputusan Q2 tercatat
- [ ] Commit terbuat

## Catatan

Uji sederhana yang membuktikan penanganan uang benar: jumlahkan `0.1` seratus kali. Dengan `number` hasilnya bukan `10`. Simpan test ini — ia menjelaskan keputusan desain lebih cepat daripada paragraf mana pun.
