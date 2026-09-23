# Design System

Kontrak visual untuk `apps/web` dan `apps/ops`. Tujuannya satu: antarmuka yang **tenang, terbaca, dan tidak terlihat seperti template**.

---

## 1. Arah desain

**Editorial travel, bukan dashboard SaaS.**

Rujukan rasa: majalah perjalanan yang rapi. Banyak ruang kosong, tipografi yang percaya diri, foto sebagai elemen utama, warna yang ditahan. Antarmuka mundur ke belakang, konten maju ke depan.

Yang **dihindari** karena membuat tampilan terasa generik:

- Gradien ungu-biru di mana-mana
- Kartu bertumpuk di dalam kartu di dalam kartu
- Emoji sebagai ikon
- Bayangan tebal dan sudut membulat berlebihan
- Setiap elemen diberi border, sehingga halaman penuh garis
- Warna aksen dipakai di banyak tempat sekaligus sampai kehilangan makna
- Animasi yang tidak punya tujuan

---

## 2. Token warna

Didefinisikan sebagai CSS custom property di `:root`, dipakai lewat Tailwind. **Dilarang menulis nilai warna langsung di komponen.**

```css
:root {
  /* Netral — tulang punggung antarmuka */
  --background:        oklch(0.99 0.002 240);
  --foreground:        oklch(0.21 0.01 250);
  --muted:             oklch(0.96 0.004 240);
  --muted-foreground:  oklch(0.52 0.012 250);
  --border:            oklch(0.92 0.005 240);
  --card:              oklch(1 0 0);

  /* Aksen — satu warna, dipakai hemat */
  --primary:           oklch(0.52 0.11 205);
  --primary-foreground:oklch(0.99 0.002 240);

  /* Semantik */
  --success:           oklch(0.58 0.12 155);
  --warning:           oklch(0.72 0.14 75);
  --destructive:       oklch(0.55 0.19 25);

  --radius: 0.625rem;
}
```

Aturan pemakaian:

- **Aksen hanya untuk satu hal per layar:** aksi utama. Tombol "Pesan sekarang" memakai aksen; tombol "Kembali" tidak
- Harga bukan aksen. Harga menonjol lewat ukuran dan ketebalan, bukan warna
- Merah hanya untuk kondisi merusak atau kesalahan. Bukan untuk diskon
- Kuning hanya untuk peringatan nyata, misal hold yang hampir habis
- Dark mode memakai token yang sama, didefinisikan ulang. Jangan menulis kelas `dark:` berisi warna mentah

---

## 3. Tipografi

Dua typeface saja.

| Peran | Font | Pemakaian |
|---|---|---|
| Antarmuka | **Inter** | Seluruh teks antarmuka, tabel, formulir |
| Tampilan | **Instrument Serif** atau **Fraunces** | Judul halaman dan judul bagian besar saja |

Serif pada judul adalah satu-satunya keputusan yang membuat tampilan tidak terlihat seperti template bootstrap. Jangan dipakai di tempat lain.

Skala:

| Token | Ukuran | Tinggi baris | Pemakaian |
|---|---|---|---|
| `display` | 40–56px | 1.1 | Judul hero, satu per halaman |
| `h1` | 30px | 1.2 | Judul halaman |
| `h2` | 24px | 1.3 | Judul bagian |
| `h3` | 18px | 1.4 | Judul kartu |
| `body` | 15px | 1.6 | Teks utama |
| `small` | 13px | 1.5 | Metadata, label |
| `caption` | 12px | 1.4 | Keterangan, syarat |

Aturan:

- Lebar baris teks berjalan maksimum 70 karakter
- Ketebalan yang dipakai hanya 400, 500, dan 600. Tidak ada 700 ke atas kecuali pada `display`
- Angka pada tabel dan harga memakai `font-variant-numeric: tabular-nums`
- Dilarang huruf kapital semua kecuali pada label berukuran `caption`

---

## 4. Ruang dan tata letak

Skala 4px: `4, 8, 12, 16, 24, 32, 48, 64, 96`. Tidak ada nilai di luar skala.

- Lebar konten maksimum 1200px, halaman detail 960px
- Jarak antar bagian minimal 48px di desktop, 32px di mobile
- Padding kartu 20px, bukan 12px. Sempit membuat tampilan terasa murah
- Halaman hasil pencarian dua kolom: filter selebar 260px, hasil mengisi sisanya. Di bawah 1024px filter berubah jadi panel yang bisa dibuka
- **Jangan menyarangkan kartu.** Kalau sesuatu terasa perlu kartu di dalam kartu, gunakan pemisah atau ubah jaraknya

---

## 5. Elevasi dan garis

- Bayangan hanya untuk elemen yang benar-benar melayang: dropdown, dialog, panel melayang
- Kartu di dalam daftar **tidak** berbayang. Cukup border tipis 1px atau perbedaan latar
- Radius seragam: 10px untuk kartu dan tombol, 6px untuk elemen kecil, penuh untuk avatar dan badge
- Satu tingkat bayangan saja: `0 1px 2px rgb(0 0 0 / 0.04), 0 4px 12px rgb(0 0 0 / 0.06)`

---

## 6. Komponen

Basis: **shadcn/ui**. Disalin ke `components/ui/`, lalu disesuaikan token-nya. Jangan menulis ulang primitif dari nol, dan jangan memakai apa adanya tanpa penyesuaian.

Komponen khusus domain yang perlu perhatian:

| Komponen | Catatan |
|---|---|
| `PropertyCard` | Foto 4:3, nama, lokasi, peringkat, harga per malam, label supplier. Seluruh kartu dapat diklik, bukan hanya tombolnya |
| `RatePlanRow` | Kebijakan pembatalan dan inklusi **wajib terlihat tanpa diklik**. Ini kewajiban dari FR-11 |
| `SearchBar` | Kota, rentang tanggal, jumlah tamu. Di mobile berubah jadi lembar penuh layar |
| `DateRangePicker` | Dua bulan di desktop, satu bulan bergulir di mobile. Tanggal tidak tersedia ditandai jelas |
| `PriceDisplay` | Harga akhir sebagai teks utama, rincian pajak di bawah dengan ukuran `small`. Jangan menyembunyikan biaya |
| `HoldCountdown` | Netral di atas 5 menit, `warning` di bawahnya. Jangan berkedip |
| `PartialResultNotice` | Pemberitahuan bahwa sebagian penyedia belum menjawab. Informatif, bukan alarm |
| `RateChangeDialog` | Harga lama, harga baru, selisih. Aksi utama "Terima harga baru", aksi sekunder "Batal" |
| `BookingStatusTimeline` | Tahapan pemesanan secara vertikal dengan keadaan sekarang ditandai |

---

## 7. Keadaan

Setiap tampilan yang mengambil data **wajib** punya empat keadaan. Tidak ada pengecualian.

| Keadaan | Aturan |
|---|---|
| Memuat | Skeleton yang menyerupai bentuk akhirnya. Bukan spinner di tengah layar |
| Kosong | Ilustrasi atau ikon sederhana, penjelasan singkat, dan satu aksi lanjutan |
| Error | Menjelaskan apa yang terjadi dalam bahasa manusia, dan menyediakan cara mencoba lagi |
| Berisi | Tampilan normal |

Khusus pencarian, ada keadaan kelima: **parsial** — sebagian supplier sudah menjawab, sebagian belum. Ini keadaan pertama kali pengguna lihat, jadi harus dirancang serius, bukan ditambahkan belakangan.

---

## 8. Gerak

- Durasi 150–250ms. Lebih lama terasa lambat, lebih cepat terasa tersentak
- Easing `cubic-bezier(0.32, 0.72, 0, 1)` untuk masuk, linear untuk keluar
- Hasil pencarian muncul bertahap dengan jeda 30ms antar kartu, maksimum sepuluh kartu pertama
- Hormati `prefers-reduced-motion`: matikan seluruh transisi posisi, sisakan perubahan opasitas
- Dilarang animasi berulang tanpa henti

---

## 9. Aksesibilitas

Bukan opsional. Dicek di setiap step frontend.

- Kontras teks minimal 4.5:1, teks besar 3:1
- Seluruh elemen interaktif dapat dicapai dengan keyboard, dengan `:focus-visible` yang terlihat jelas
- Target sentuh minimal 44×44px
- Setiap input punya `<label>`, bukan hanya placeholder
- Dialog mengunci fokus dan dapat ditutup dengan Escape
- Perubahan status yang tidak terlihat diumumkan lewat `aria-live`, misalnya "3 dari 5 penyedia menjawab"
- Gambar properti punya `alt` yang bermakna
- Warna tidak pernah menjadi satu-satunya pembawa informasi

---

## 10. Responsif

Titik henti: `640`, `768`, `1024`, `1280`.

- Rancang mobile lebih dulu. Halaman hasil pencarian di mobile adalah tampilan yang paling banyak dipakai
- Filter di mobile berupa lembar bawah, bukan menu bertumpuk
- Tabel tidak pernah digulir horizontal di mobile. Ubah jadi daftar kartu
- Aksi utama di mobile menempel di bawah layar pada halaman detail dan pemesanan

---

## 11. Yang dicek di setiap step frontend

- [ ] Tidak ada nilai warna mentah di komponen, semuanya token
- [ ] Tidak ada nilai jarak di luar skala 4px
- [ ] Empat keadaan tersedia untuk setiap tampilan yang mengambil data
- [ ] Bisa dioperasikan penuh dengan keyboard
- [ ] Kontras memenuhi AA
- [ ] Terlihat benar pada lebar 375px
- [ ] `prefers-reduced-motion` dihormati
- [ ] Tidak ada kartu bersarang
- [ ] Warna aksen dipakai maksimal untuk satu aksi utama per layar
