# @tbe/money

Nilai uang yang selalu membawa mata uangnya, dan aritmetika yang tidak pernah menyentuh pecahan biner.

Memenuhi NFR-08.

## Yang paling penting di sini

**Tidak ada nilai uang yang boleh bertipe `number`.**

```ts
let naive = 0
for (let index = 0; index < 100; index += 1) naive += 0.1
// naive === 9.99999999999998
```

Kesalahan ini tidak menggagalkan apa pun. Ia tidak melempar galat, tidak membuat uji gagal selama semua angkanya bulat, dan tidak terlihat di tampilan mana pun. Ia hanya membuat setiap angka sedikit meleset, dan baru ketahuan saat rekonsiliasi tidak pernah cocok — pada titik mana tidak ada yang tahu sejak kapan.

```ts
const total = sum(
  Array.from({ length: 100 }, () => money(10, 'IDR')),
  'IDR',
)
// total.amountMinor === 1000, tepat
```

Aturan ini dijaga skrip, bukan niat baik:

```bash
pnpm verify:money
```

Skrip itu memindai seluruh repo untuk bidang bernama uang yang bertipe `number`, dan seluruh skema Prisma untuk kolom `Float` atau `Decimal`. Ia gagal dengan nomor baris, bukan dengan peringatan.

## Rupiah tidak punya sen

`Money` menyimpan jumlah dalam **satuan terkecil** — sen untuk dolar, rupiah penuh untuk rupiah:

| Mata uang | Eksponen | `amountMinor: 1000` berarti |
| --------- | -------- | --------------------------- |
| IDR       | 0        | Rp 1.000                    |
| USD       | 2        | $10,00                      |

Ini **menyimpang dari ISO 4217**, yang memberi IDR eksponen 2. Penyimpangannya disengaja dan didokumentasikan di [`src/currency.ts`](src/currency.ts): memakai eksponen 2 berarti setiap angka rupiah di seluruh sistem menjadi ambigu — `2893400` bisa berarti Rp 2.893.400 atau Rp 28.934,00, dan tidak ada apa pun dalam tipe yang membedakannya. Sen rupiah tidak dipakai di mana pun dalam praktik; membawanya hanya menambah nol yang menunggu salah dibaca.

Pembulatan keduanya karena itu berbeda, dan perbedaannya diuji.

## Lintas mata uang ditolak saat kompilasi

```ts
add(money(1_000, 'IDR'), money(1_000, 'USD'))
//                       ~~~~~~~~~~~~~~~~~~~
// Argument of type 'Money<"USD">' is not assignable to parameter of type 'Money<"IDR">'
```

Bekerja lewat `NoInfer<C>` pada parameter kedua: argumen pertama yang menentukan mata uangnya, dan yang kedua harus mengikuti. Bila keduanya sama-sama `Money` tanpa parameter — misalnya datang dari JSON — penolakannya terjadi saat jalan, bukan hilang.

Konversi harus dinyatakan, dan memerlukan kurs:

```ts
convert(money(10_000, 'USD'), 'IDR', { amount: 1_623_575, scale: 2 })
```

## Pembulatan sekali, di akhir

`PreciseMoney` membawa `scale` tambahan sehingga hasil antara tidak perlu dibulatkan:

```ts
const once = round(multiply(money(1_005, 'IDR'), { amount: 10_750, scale: 4 }), 'half_even')
```

Membulatkan di setiap langkah menghasilkan angka lain. Selisihnya satu rupiah per pemesanan, dan satu rupiah per pemesanan adalah selisih yang nyata pada volume mana pun yang layak disebut produksi. Buktinya ada di [`src/money.test.ts`](src/money.test.ts).

Mode pembulatan **selalu** argumen eksplisit. Tidak ada bawaan tersembunyi: `PRICE_ROUNDING` adalah konstanta yang harus dioper, bukan nilai yang diam-diam dipakai.

## `allocate` tidak kehilangan satu rupiah pun

```ts
allocate(money(10, 'IDR'), [1, 1, 1])
// [4, 3, 3] — jumlahnya tepat 10, bukan 9
```

Sisa pembagian dibagikan ke bagian-bagian awal, bukan dibuang. Pembagian yang kehilangan satu satuan terkecil adalah cara paling umum sebuah sistem pembayaran berhenti seimbang.

## Penyimpanan

Dua kolom, selalu:

```prisma
fixedAmountMinor Int?    @map("fixed_amount_minor")
fixedCurrency    String? @map("fixed_currency")
```

`toColumns` dan `fromColumns` yang menjembatani. Tidak pernah satu kolom `Float`, dan tidak pernah `Decimal` — yang terakhir kembali sebagai objek pustaka yang harus diurai lagi di setiap tempat yang membacanya.

Untuk JSON dan pesan antar-service: `toJson` / `parseMoney`, dengan `moneySchema` sebagai skema Zod yang dipakai langsung di validasi HTTP.

## Pemformatan terpisah dari perhitungan

`format()` ada di modulnya sendiri dan tidak pernah dipanggil dari jalur perhitungan mana pun. Angka yang sudah menjadi string adalah angka yang sudah selesai dihitung.

## Uji

```bash
pnpm --filter @tbe/money test
```

38 test. Yang paling menjelaskan keputusan desainnya adalah yang menjumlahkan `0.1` seratus kali — ia mengatakan lebih banyak daripada paragraf mana pun di berkas ini.
