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

- [x] Tidak ada satu pun nilai uang bertipe `number` di seluruh repo — ditegakkan `pnpm verify:money`
- [x] Tidak ada kolom `float` atau `double` di skema Prisma mana pun — skrip yang sama
- [x] Penjumlahan berulang tidak menghasilkan galat pembulatan — dibuktikan dengan test
- [x] Operasi lintas mata uang ditolak — saat kompilasi lewat `NoInfer`, saat jalan bila tipenya melebur
- [x] Urutan perhitungan dinyatakan eksplisit dan diuji terhadap contoh manual — 19 test domain
- [x] Rincian harga dikembalikan lengkap, bukan hanya total
- [x] Memproses 500 rate plan tidak menghasilkan query per item — dibuktikan dengan menghitung pembacaan
- [x] Keputusan Q2 tercatat — ADR-0002
- [ ] Migrasi dan seed berjalan terhadap Postgres sungguhan — **belum diverifikasi**, Docker mati
- [x] Cakupan test: money 98.6%, pricing-service 100%
- [x] Commit terbuat

## Catatan

Uji yang menjumlahkan `0.1` seratus kali disimpan di `packages/money/src/money.test.ts`. Ia menjelaskan keputusan desainnya lebih cepat daripada seluruh ADR-0002.

### Temuan saat mengerjakan step ini

**1. Eksponen IDR diputuskan 0, menyimpang dari ISO 4217.** dinero.js memberi IDR eksponen 2 mengikuti standar. Memakainya berarti setiap angka rupiah di seluruh sistem menjadi ambigu — `2893400` bisa berarti Rp 2.893.400 atau Rp 28.934,00, dan tidak ada apa pun dalam tipe yang membedakannya. `packages/money` karena itu memelihara tabel eksponennya sendiri. Dicatat di ADR-0002.

**2. Rincian harga tidak dapat dibulatkan per komponen.** Membulatkan `base`, `markup`, dan `tax` masing-masing menghasilkan jumlah yang meleset satu satuan dari total yang dibulatkan sekali. Yang dipakai: `base` dan `markup` dibulatkan, lalu `tax` diturunkan sebagai `total − base − markup`. Rinciannya dengan begitu selalu menjumlah tepat, dan totalnya tetap hasil pembulatan sekali di akhir.

**3. Syarat "tanpa query per item" hanya dapat dibuktikan dengan menghitung pembacaan.** Versi yang mengukur waktu akan lulus pada mesin cepat meski kuerinya berulang lima ratus kali. Penyimpanan uji karena itu menghitung dirinya dibaca. Ditambah satu uji pendamping yang memastikan kelima ratus hasilnya berbeda satu sama lain — tanpa itu, kode yang mengembalikan hasil yang sama untuk semua item akan lulus hitungan pembacaan.

**4. Prioritas aturan saja tidak cukup untuk determinisme.** Dua aturan berprioritas sama akan dipilih menurut urutan baris dari basis data, dan urutan baris berubah setiap kali ada yang diedit. Pemutusnya: kekhususan cakupan, lalu pengenal. Yang terakhir bukan karena pengenal punya arti, melainkan supaya hasilnya tidak berubah antar pemanggilan.

**5. Aturan markup yang rusak diperlakukan sebagai "tanpa markup", bukan "nol persen".** Perbedaannya terlihat di rincian: tanpa markup tidak menyebut aturan mana pun. Tetapi jalur pembuatannya menolak aturan seperti itu lebih dulu — aturan yang tersimpan tetapi tidak pernah berlaku adalah aturan yang operatornya yakin sedang berjalan.

**6. `verify-money.mjs` menemukan empat kecocokan, tiga di antaranya salah tangkap — dan menyisirnya justru memperbaiki kode.** `PaginationMeta.total` di shared-kernel adalah cacah baris, bukan uang; diganti menjadi `totalItems`, yang memang lebih jelas. `priceDriftRate` di mock-supplier adalah pecahan, bukan uang; polanya diperbaiki supaya akhiran `Rate`, `Ratio`, `Factor`, dan `Percent` tidak lagi tertangkap. Yang keempat, bentuk kawat SKY, dikecualikan dengan alasan tertulis: mock-supplier memang bertugas memancarkan bentuk asing.

**7. Skripnya diuji dengan sengaja dilanggar.** Sebuah `totalPrice: number` dan sebuah kolom `price Float` ditanam sementara, dan keduanya tertangkap dengan nomor baris. Skrip verifikasi yang belum pernah gagal tidak membuktikan apa pun tentang kode — ia hanya membuktikan dirinya tidak berjalan.

**8. Kurs terbaru dipilih menurut tanggalnya, bukan urutan barisnya.** Uji awal kebetulan menyusun kurs berurutan naik, sehingga cabang "baris ini lebih lama" tidak pernah dijalankan. Cakupan cabang yang kurang satu itu yang menunjukkannya; ditambah uji dengan urutan terbalik.

**9. Factory penyimpanan Prisma melewati batas 50 baris.** Dipecah menjadi satu fungsi per operasi dengan factory yang hanya merangkai — bentuk yang sama dengan kelima adapter di Step 10.

### Yang belum diverifikasi

**Postgres belum pernah menyala bersama service ini.** Docker masih mati.

Yang sudah terbukti lewat 114 test (38 money + 76 pricing-service): seluruh keputusan perhitungan — urutan, pembulatan sekali di akhir, perbedaan pembulatan IDR dan USD, prioritas aturan markup, kegagalan per item, jatuh kembali saat Redis tumbang, dan penolakan di batas HTTP.

Yang belum terbukti: migrasi Prisma belum pernah diterapkan, seed belum pernah dijalankan, dan cache kurs belum pernah menyentuh Redis sungguhan — yang terakhir diuji lewat Redis palsu yang memaksa kegagalan baca dan tulis.

Jalankan ini setelah Docker menyala:

```bash
pnpm infra:up
cp apps/pricing-service/.env.example apps/pricing-service/.env
pnpm --filter @tbe/pricing-service db:migrate
pnpm --filter @tbe/pricing-service db:seed
pnpm --filter @tbe/pricing-service dev
```

Lalu buktikan kesiapan dan satu perhitungan menyeluruh:

```bash
curl -s localhost:4005/health/ready
curl -s -X POST localhost:4005/internal/pricing/rate-plans   -H 'content-type: application/json'   -d '{"items":[{"ref":"a","supplier":"SKY","city":"Bali","supplierTotal":{"amountMinor":1000000,"currency":"IDR"}}]}'
```

Markup seed 12% dan PPN 11% menghasilkan total Rp 1.243.200. Angka lain berarti seed atau konfigurasinya berbeda dari yang diharapkan.
