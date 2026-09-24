# ADR-0001 — Identitas properti lintas supplier

**Status:** Diterima · **Tanggal:** 2026-09-24 · **Menjawab:** Q5 pada PRD Bab 14

> Dilengkapi pada Step 12b dengan alternatif pass-through yang ditolak, pembedaan katalog dan inventaris, serta alasan kepemilikan katalog. Keputusannya tidak berubah.

## Konteks

Satu hotel fisik yang sama ditawarkan oleh beberapa supplier sekaligus, dan setiap supplier menyebutnya dengan pengenal, nama, dan harga yang berbeda. Pada mock-supplier, properti yang sama muncul sebagai:

| Supplier | Pengenal          | Nama                             |
| -------- | ----------------- | -------------------------------- |
| SKY      | `sky-120804930`   | `Padma Bali Boutique Hotel`      |
| NOVA     | `nova-345515035`  | `PADMA BALI BOUTIQUE HOTEL`      |
| ORBIT    | `orbit-135144571` | `Wijaya Bali Grand Hotel (Bali)` |
| LUNA     | `luna-338221784`  | `Hotel Wijaya Bali Grand Hotel`  |
| ZEPH     | `zeph-470134641`  | `Padma Bali Boutique Htl.`       |

Tanpa keputusan soal identitas, hasil pencarian akan menampilkan hotel yang sama tiga kali sebagai tiga hotel berbeda, dan pengguna tidak dapat membandingkan harga — padahal membandingkan harga adalah seluruh alasan produk ini ada.

## Pilihan yang dipertimbangkan

**1. Pencocokan kabur saat berjalan.** Mencocokkan nama, koordinat, dan alamat pada setiap pencarian.

Ditolak. Pencocokan berbasis nama rapuh terhadap variasi penulisan yang justru sengaja ditanam di data uji: kapital semua, awalan "Hotel", singkatan "Htl.". Lebih buruk, biayanya dibayar pada setiap pencarian, di jalur yang paling sensitif terhadap waktu, dan hasilnya tidak deterministik — dua pencarian yang sama dapat menghasilkan pengelompokan berbeda ketika satu supplier lambat menjawab.

**2. Katalog internal lengkap.** Menyimpan properti beserta harga dan ketersediaannya.

Ditolak. Ini membatalkan premis sistem: inventaris bukan milik kita. Harga dan ketersediaan yang disimpan akan basi dalam hitungan menit, dan menampilkan harga basi lalu menolaknya saat pembayaran adalah kegagalan produk yang paling merusak kepercayaan.

**3. Pass-through murni.** Tidak ada katalog sama sekali. Setiap properti yang dikembalikan supplier ditampilkan apa adanya, dengan pengenal supplier sebagai identitasnya.

Ditolak, dan ini alternatif yang paling menggoda karena paling sedikit kodenya. Tiga akibatnya:

Pertama, hotel yang sama muncul sebanyak supplier yang menjualnya. Pengguna melihat "Padma Bali Boutique Hotel", "PADMA BALI BOUTIQUE HOTEL", dan "Hotel Padma Bali Boutique Hotel" sebagai tiga hotel berbeda dengan tiga harga berbeda, dan tidak ada cara mengetahui bahwa ketiganya satu kamar yang sama. Membandingkan harga adalah seluruh alasan produk ini ada.

Kedua, tidak ada URL yang stabil. Identitas properti menjadi milik supplier, yang berarti URL halaman properti berubah begitu supplier mengubah pengenalnya — dan hilang sepenuhnya begitu supplier berhenti menjual properti itu. PRD Bab 12 mewajibkan halaman properti dapat diindeks mesin pencari, dan halaman yang URL-nya tidak dapat dijanjikan tidak dapat diindeks dengan berguna.

Ketiga, autocomplete menjadi mustahil tanpa memanggil kelima supplier pada setiap ketikan.

**4. Katalog internal untuk data statis saja, dengan tabel pemetaan.** ← **dipilih**

## Keputusan

Ada katalog properti internal yang memuat **hanya data statis**: nama kanonik, alamat, koordinat, foto, dan fasilitas. Pemetaan dari pengenal supplier ke pengenal properti internal disimpan di tabel tersendiri.

**Harga dan ketersediaan tidak pernah masuk katalog.** Keduanya selalu bersumber dari supplier pada setiap pencarian.

### Katalog dan inventaris adalah dua hal yang berbeda

Pembedaan ini yang menjaga premis dasar project tetap utuh, dan ia layak dinyatakan terpisah karena mudah kabur dalam praktik:

|            | Katalog                                              | Inventaris                                        |
| ---------- | ---------------------------------------------------- | ------------------------------------------------- |
| Isinya     | nama, alamat, koordinat, zona waktu, fasilitas, foto | harga, ketersediaan, rate plan, syarat pembatalan |
| Pemiliknya | kita                                                 | supplier                                          |
| Umurnya    | berbulan-bulan                                       | hitungan menit                                    |
| Disimpan?  | ya                                                   | **tidak pernah**                                  |

Batasnya kabur secara bertahap, bukan sekaligus. Yang pertama masuk biasanya bukan "harga", melainkan sesuatu yang terasa netral: `lowestPriceSeen` untuk pengurutan, atau `hasAvailability` untuk menyaring hasil kosong. Keduanya menghemat panggilan, membuat halaman terasa lebih cepat, dan tidak menggagalkan satu pun uji.

Yang terjadi kemudian selalu sama: angka itu basi, pengguna melihat harga yang tidak ada lagi, dan pemesanannya ditolak saat pembayaran — kegagalan produk yang paling merusak kepercayaan, dan yang paling sulit dilacak kembali ke kolom yang menyebabkannya.

Karena itu batas ini tidak dijaga oleh komentar melainkan oleh skrip: `pnpm verify:catalog` menolak kolom bernama harga atau ketersediaan di ketiga model katalog, dan menolak berjalan kalau modelnya sudah berganti nama.

### Katalog dimiliki search-service

Bukan service tersendiri. Alasannya PRAKTIS, dan lebih baik mengakuinya daripada mengarang pembenaran arsitektural: search adalah satu-satunya konsumennya, dan memisahkannya hanya menambah satu lompatan jaringan di jalur yang paling sensitif terhadap waktu — untuk tabel yang muat di memori.

Kalau nanti ada konsumen kedua di luar search, pemisahan menjadi service tersendiri baru punya alasan. Sampai saat itu, ia adalah modul di dalam search-service dengan batasnya sendiri.

Dibangun pada Step 12b.

### Konsekuensi bagi lapisan adapter (Step 10)

Adapter **tidak melakukan pencocokan apa pun**. Ia mengembalikan pengenal properti versi supplier apa adanya, beserta nama, koordinat, dan alamat mentah sebagai data pendukung.

Data pendukung itu tetap disertakan meski tidak satu pun adapter memakainya, karena Step 12b membutuhkannya untuk dua hal: membangun tabel pemetaan, dan menampilkan properti yang belum terpetakan.

Batasan ini ditegakkan oleh bentuk model kanonik: tidak ada bidang `propertyId` internal di mana pun di `packages/supplier-adapters`. Bidang yang tidak ada tidak dapat diisi diam-diam.

## Konsekuensi lain

**Baik:**

- Deduplikasi menjadi pencarian di tabel pemetaan, bukan pencocokan kabur di jalur kritis
- URL properti stabil, sehingga rendering sisi server dan ISR dapat berjalan (PRD Bab 12)
- Autocomplete memakai full-text pada katalog, bukan memanggil lima supplier
- Premis "inventaris bukan milik kita" tetap utuh

**Harga yang dibayar:**

- Ada proses pemetaan yang harus dibangun dan dirawat
- Properti yang dikembalikan supplier tetapi belum terpetakan ditampilkan apa adanya tanpa URL stabil, dan masuk antrian pemetaan. Properti seperti itu tidak dapat dibandingkan harganya dengan properti lain sampai pemetaannya ada
- Katalog dapat menyimpang dari kenyataan bila hotel berganti nama atau tutup; perlu penyegaran berkala

## Catatan

Yang membuat keputusan ini bekerja adalah pemisahan antara data statis dan data dinamis. Katalog yang ikut menyimpan harga akan tampak lebih cepat dan menjadi sumber kegagalan yang paling mahal: pengguna melihat harga yang tidak ada lagi.
