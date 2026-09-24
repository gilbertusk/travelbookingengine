# ADR-0002 — Representasi nilai uang

**Status:** Diterima · **Tanggal:** 2026-09-24 · **Menjawab:** Q2 pada PRD Bab 14

## Konteks

NFR-08 melarang aritmetika pecahan biner untuk nilai uang. Larangan itu mudah dinyatakan dan hampir mustahil dijaga dengan mata: satu bidang `price: number` tetap dikompilasi dengan benar, tetap lolos setiap pengujian selama angkanya bulat, dan tidak terlihat di tampilan mana pun. Ia hanya membuat setiap angka sedikit meleset, dan baru ketahuan saat rekonsiliasi tidak pernah cocok — pada titik mana tidak ada yang tahu sejak kapan.

Q2 pada PRD sudah dijawab: dukung **dua** mata uang, IDR dan USD. Dua sudah cukup untuk membuktikan konversi dan pembulatan lintas mata uang bekerja, dan sudah selaras dengan rancangan mock-supplier pada Step 04 — sebagian supplier memberi harga dalam dolar.

Yang belum diputuskan, dan yang diputuskan di sini, adalah **bagaimana kedua mata uang itu diwakili**. Keputusan ini tidak dapat ditunda: ia menentukan bentuk setiap kolom uang di setiap skema, setiap muatan pesan antar-service, dan setiap bidang di antarmuka.

## Keputusan

### 1. Setiap nilai uang membawa mata uangnya

Tipe `Money` terdiri dari jumlah dalam satuan terkecil **ditambah** kode mata uang. Tidak ada nilai uang tanpa mata uang di mana pun — tidak di basis data, tidak di pesan, tidak di antarmuka HTTP.

Alasannya bukan kerapian. `1000` tanpa mata uang bisa berarti Rp 1.000 atau $10,00, dan keduanya terlihat sama persis di setiap log, setiap debugger, dan setiap uji yang membandingkannya.

### 2. Rupiah memakai eksponen 0, menyimpang dari ISO 4217

| Mata uang | Eksponen ISO 4217 | Eksponen di sini | `amountMinor: 1000` berarti |
| --------- | ----------------- | ---------------- | --------------------------- |
| IDR       | 2                 | **0**            | Rp 1.000                    |
| USD       | 2                 | 2                | $10,00                      |

Sen rupiah tidak dipakai di mana pun dalam praktik. Memakai eksponen 2 berarti setiap angka rupiah di seluruh sistem menjadi ambigu — `2893400` bisa berarti Rp 2.893.400 atau Rp 28.934,00, dan tidak ada apa pun dalam tipe yang membedakannya. Ambiguitas seperti itu tidak menimbulkan galat; ia menimbulkan angka yang salah seratus kali lipat dan tampak wajar.

Konsekuensinya: `packages/money` memelihara tabel eksponennya sendiri alih-alih memakai bawaan dinero.js, yang mengikuti ISO. Perbedaan itu didokumentasikan di berkas yang memuatnya, bukan hanya di sini.

### 3. Penyimpanan selalu dua kolom bilangan bulat

```prisma
fixedAmountMinor Int?    @map("fixed_amount_minor")
fixedCurrency    String? @map("fixed_currency")
```

Tidak ada `Float`, tidak ada `Double`, dan tidak ada `Decimal` di skema mana pun. Dua yang pertama kehilangan presisi diam-diam. Yang ketiga tidak kehilangan presisi, tetapi kembali dari Prisma sebagai objek pustaka yang harus diurai lagi di setiap tempat yang membacanya — dan setiap tempat yang lupa mengurainya kembali ke pecahan biner tanpa satu pun peringatan.

Kurs mengikuti aturan yang sama: bilangan bulat berskala, `rate` ditambah `scale`. 16.235,75 disimpan sebagai `rate=1623575, scale=2`.

### 4. Operasi lintas mata uang ditolak saat kompilasi bila mungkin

```ts
add(money(1_000, 'IDR'), money(1_000, 'USD')) // galat tipe
```

Bekerja lewat `NoInfer<C>` pada parameter kedua. Ketika kedua sisi datang dari JSON dan tipenya melebur menjadi `Money` tanpa parameter, penolakannya tetap terjadi — saat jalan, bukan hilang.

### 5. Larangan ditegakkan skrip, bukan niat baik

`pnpm verify:money` memindai seluruh repo untuk bidang bernama uang yang bertipe `number`, dan seluruh skema Prisma untuk kolom `Float` atau `Decimal`. Ia gagal dengan nomor baris.

Skrip ini dibuat karena aturan yang hanya ditulis di dokumen akan dilanggar oleh orang yang belum pernah membaca dokumen itu — termasuk penulisnya sendiri enam bulan kemudian.

## Pilihan yang dipertimbangkan

**1. `number` dengan disiplin.** Menyimpan rupiah sebagai bilangan bulat biasa dan berhati-hati.

Ditolak. Rupiah sebagai bilangan bulat sebenarnya bekerja untuk penjumlahan — masalahnya muncul pada perkalian, dan markup serta pajak keduanya perkalian. Lebih penting: "berhati-hati" tidak dapat diuji, dan yang tidak dapat diuji tidak bertahan melewati orang ketiga yang menyentuh kodenya.

**2. `Decimal` dari Prisma di seluruh sistem.** Memakai tipe desimal basis data sebagai tipe kanonik.

Ditolak. Ia mengikat representasi uang ke satu ORM, dan tidak menyelesaikan apa pun di lapisan yang tidak menyentuh basis data — muatan Kafka, respons HTTP, dan perhitungan di domain semuanya tetap harus mengubahnya. Setiap perubahan itu adalah tempat presisinya dapat hilang.

**3. Abstraksi mata uang penuh sejak awal.** Tabel mata uang, eksponen dari basis data, konversi berantai.

Ditolak. Q2 menjawab dua mata uang, dan dua mata uang tidak membutuhkannya. Abstraksi untuk mata uang yang belum ada adalah kode yang tidak pernah dijalankan dengan sungguhan, dan kode seperti itu selalu salah ketika akhirnya dibutuhkan.

## Konsekuensi

**Baik:**

- Setiap nilai uang dapat dibaca tanpa bertanya "ini satuan apa"
- Kesalahan lintas mata uang menjadi galat kompilasi, bukan angka yang salah
- Rekonsiliasi pada Step 28 bekerja pada bilangan bulat, yang dapat dibandingkan dengan tepat
- Larangan NFR-08 dapat dibuktikan lulus, bukan diklaim

**Harga yang dibayar:**

- Menyimpang dari ISO 4217 untuk IDR. Sistem luar yang mengirim rupiah dengan eksponen 2 harus dikonversi di lapisan adapter, dan konversi itu harus diingat
- Dua kolom untuk setiap nilai uang di setiap tabel, bukan satu
- `packages/money` menjadi dependensi hampir setiap service

## Catatan

Uji yang paling menjelaskan keputusan ini bukan salah satu uji pembulatan, melainkan yang menjumlahkan `0.1` seratus kali dan menunjukkan hasilnya bukan `10`. Enam baris, dan ia mengatakan lebih banyak daripada seluruh dokumen ini.
