# pricing-service

Mengubah harga supplier menjadi harga jual akhir, beserta rincian yang menjelaskan bagaimana angkanya sampai di sana.

Memenuhi FR-05, FR-30, dan NFR-08.

## Yang paling penting di sini

**Urutan perhitungannya dinyatakan, bukan disimpulkan dari kode.**

```
harga supplier → konversi mata uang → markup → pajak → pembulatan, SEKALI
```

Urutan ini bukan selera. Menukar markup dan pajak mengubah harga jual:

| Urutan                      | Pajak      | Total        |
| --------------------------- | ---------- | ------------ |
| markup lalu pajak _(benar)_ | Rp 126.500 | Rp 1.276.500 |
| pajak lalu markup           | Rp 110.000 | Rp 1.260.000 |

Selisihnya **Rp 16.500 per pemesanan** pada harga supplier Rp 1.000.000 dengan markup 15% dan PPN 11%. Itu bukan pembulatan — itu markup dikali tarif pajak, dan ia menumpuk pada setiap transaksi.

Setiap angka yang diharapkan di [`src/domain/pricing.test.ts`](src/domain/pricing.test.ts) **dihitung tangan dan ditulis perhitungannya** di komentar. Uji harga yang hanya membandingkan dengan keluaran kode itu sendiri tidak membuktikan apa pun; ia hanya membekukan kesalahan yang sudah ada.

## Pembulatan sekali, di akhir

Konversi, markup, dan pajak semuanya bekerja pada `PreciseMoney` — nilai yang membawa skala tambahan dan belum dibulatkan. Hanya total akhir yang dibulatkan.

Rinciannya tetap **menjumlah tepat ke totalnya**: `base` dan `markup` dibulatkan, lalu `tax` diturunkan sebagai `total − base − markup`. Rincian yang tidak menjumlah ke totalnya membuat pengguna berhenti percaya pada angkanya, dan DESIGN-SYSTEM.md mewajibkan rincian itu ditampilkan pada komponen `PriceDisplay`.

IDR dibulatkan ke rupiah penuh, USD ke sen. Perbedaan itu diuji terpisah — lihat [`@tbe/money`](../../packages/money/README.md) untuk alasan eksponen IDR di sini adalah 0, bukan 2 seperti ISO 4217.

## Tidak ada kueri per rate plan

Penetapan harga berada di jalur kritis pencarian dan menerima **ratusan** rate plan dalam satu panggilan. Kurs dan aturan markup dimuat **sekali per panggilan**, lalu disaring di memori.

Ini syarat, bukan optimasi. Port yang berbentuk `findRuleFor(supplier, city)` akan menghasilkan satu kueri per rate plan, dan lima ratus kueri dalam satu permintaan pencarian adalah cara paling pasti membuat pencarian melewati anggaran waktunya.

Dibuktikan dengan **menghitung pembacaan**, bukan mengukur waktu:

```ts
expect(run.results).toHaveLength(500)
expect(world.rates.reads.count).toBe(1)
expect(world.rules.reads.count).toBe(1)
```

Pengukuran waktu akan lulus pada mesin cepat meski kuerinya berulang lima ratus kali. Uji pendampingnya memastikan kelima ratus hasilnya **berbeda satu sama lain**, supaya menghitung pembacaan saja tidak dapat lulus dengan kode yang mengembalikan hasil yang sama untuk semua item.

## Prioritas aturan markup

Lebih dari satu aturan dapat cocok. Yang menang ditentukan dengan urutan berikut, dan setiap tingkatnya diuji:

1. **Prioritas** tertinggi — dinyatakan operator
2. **Kekhususan** cakupan — supplier + kota > supplier > kota > global
3. **Pengenal** terkecil — pemutus terakhir, supaya hasilnya deterministik

Tingkat ketiga bukan karena pengenal punya arti. Tanpanya, dua aturan berprioritas dan berkekhususan sama akan dipilih menurut urutan baris dari basis data — dan urutan baris berubah setiap kali ada yang diedit.

**Satu aturan saja yang berlaku, bukan gabungan beberapa.** Markup yang ditumpuk membuat harga akhir mustahil dijelaskan kepada operator yang bertanya "kenapa harganya segini", dan mustahil dibatalkan sebagian.

Aturan yang dihapus **dinonaktifkan, bukan dihilangkan**: harga pemesanan lama merujuknya lewat `appliedMarkupRuleId`, dan baris yang hilang membuat pertanyaan itu tidak dapat dijawab lagi.

## Kurs

Baris kurs **tidak pernah diperbarui di tempat**. Kurs baru adalah baris baru dengan `effective_from` yang lebih baru; riwayatnya itulah yang membuat harga pemesanan lama tetap dapat dijelaskan berbulan-bulan kemudian.

Yang terbaru menang — menurut **tanggalnya**, bukan menurut urutan baris yang dikembalikan basis data.

Kurs di-cache di Redis dengan TTL pendek. Pendek dengan sengaja: kurs basi berarti harga jual yang salah, dan harga jual yang salah adalah kerugian, bukan sekadar tampilan yang usang.

**Redis yang tumbang tidak menggagalkan penetapan harga** — ia jatuh kembali ke basis data dan melaporkan kegagalannya. Harga yang tidak terhitung karena cache tumbang jauh lebih mahal daripada satu pencarian yang sedikit lambat.

## Kegagalan per item, bukan per panggilan

Satu rate plan yang tidak dapat dihitung dikembalikan sebagai kegagalannya sendiri, bersama hasil yang berhasil:

```json
{ "data": { "priced": [...], "failed": [{ "ref": "...", "error": {...} }], "ratesUsed": [...] } }
```

Satu kurs yang hilang untuk satu supplier tidak boleh menghapus hasil dari empat supplier lain.

Kegagalan yang dilaporkan, bukan ditebak: kurs yang hilang **menggagalkan** perhitungan alih-alih memakai 1:1. Menebak kurs menghasilkan harga yang keliru ribuan kali lipat dan terlihat masuk akal secara tipe.

## Menjalankan

```bash
cp apps/pricing-service/.env.example apps/pricing-service/.env
pnpm infra:up
pnpm --filter @tbe/pricing-service db:migrate
pnpm --filter @tbe/pricing-service db:seed
pnpm --filter @tbe/pricing-service dev
```

Seed wajib. Tabel kurs yang kosong membuat service menyatakan dirinya **belum siap**, dan itu disengaja: tanpa kurs, setiap harga supplier dalam dolar gagal dihitung, dan gagal diam-diam untuk sebagian hasil jauh lebih buruk daripada menolak trafik sejak awal.

## Antarmuka

Seluruhnya internal. Tidak satu pun terdaftar sebagai rute publik di api-gateway; rute aturan markup dilindungi peran operator **di gateway**, bukan di sini.

| Metode   | Rute                                 | Untuk                                  |
| -------- | ------------------------------------ | -------------------------------------- |
| `POST`   | `/internal/pricing/rate-plans`       | Harga akhir untuk sekumpulan rate plan |
| `GET`    | `/internal/pricing/rates`            | Kurs yang berlaku                      |
| `GET`    | `/internal/pricing/markup-rules`     | Seluruh aturan, termasuk yang nonaktif |
| `POST`   | `/internal/pricing/markup-rules`     | Membuat aturan (FR-30)                 |
| `PATCH`  | `/internal/pricing/markup-rules/:id` | Mengubah aturan                        |
| `DELETE` | `/internal/pricing/markup-rules/:id` | Menonaktifkan aturan                   |

Batas satu panggilan: **2.000 rate plan**. Besar dengan sengaja — pencarian di satu kota dengan lima supplier menghasilkan ratusan rate plan, dan menolak di bawah itu akan memaksa pemanggil memecah permintaan, yang justru mengembalikan kueri berulang yang ingin dihindari.

Aturan persentase tanpa angka persentasenya **ditolak saat dibuat**, bukan diam-diam menjadi "tanpa markup" saat dipakai. Aturan yang tersimpan tetapi tidak pernah berlaku adalah aturan yang operatornya yakin sedang berjalan.

## Uji

```bash
pnpm --filter @tbe/pricing-service test
```

76 test, cakupan 100%. Uji HTTP dirangkai lewat factory yang sama dengan produksi — hanya port-nya yang dipalsukan.
