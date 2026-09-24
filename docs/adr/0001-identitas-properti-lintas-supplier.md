# ADR-0001 — Identitas properti lintas supplier

**Status:** Diterima · **Tanggal:** 2026-09-24 · **Menjawab:** Q5 pada PRD Bab 14

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

**3. Katalog internal untuk data statis saja, dengan tabel pemetaan.** ← **dipilih**

## Keputusan

Ada katalog properti internal yang memuat **hanya data statis**: nama kanonik, alamat, koordinat, foto, dan fasilitas. Pemetaan dari pengenal supplier ke pengenal properti internal disimpan di tabel tersendiri.

**Harga dan ketersediaan tidak pernah masuk katalog.** Keduanya selalu bersumber dari supplier pada setiap pencarian.

Katalog dimiliki search-service, dan dibangun pada Step 12b.

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
