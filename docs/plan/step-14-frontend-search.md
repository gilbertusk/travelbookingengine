# Step 14 — Frontend: pencarian dan hasil

**Fase 2** · Milestone 3 · Estimasi 8 jam · Prasyarat: Step 13

## Tujuan

Layar yang paling sering dilihat pengguna, dan layar pertama yang dilihat penilai portofolio. Keadaan parsial harus dirancang sebagai keadaan utama, bukan tambalan.

## Prompt

```
Bangun alur pencarian dan halaman hasil di apps/web.

Baca terlebih dahulu:
- docs/plan/DESIGN-SYSTEM.md, seluruhnya
- docs/plan/CONVENTIONS.md bagian 13
- PRD FR-01 sampai FR-12 dan US-01

1. SearchBar
   - Input kota dengan saran otomatis (FR-08), debounce, dan dukungan keyboard penuh
   - DateRangePicker: dua bulan di desktop, satu bulan bergulir di mobile.
     Tanggal lampau dinonaktifkan, rentang maksimum dibatasi
   - Pemilih jumlah tamu
   - Di mobile berubah menjadi lembar penuh layar dengan langkah berurutan
   - Kriteria pencarian tersimpan di URL sebagai query param, sehingga halaman
     hasil dapat dibagikan dan dimuat ulang

2. Halaman hasil
   - Dua kolom: filter selebar 260px, daftar hasil mengisi sisanya
   - Di bawah 1024px filter menjadi lembar bawah
   - Rendering sisi server untuk pemuatan pertama, sesuai PRD Bab 12 soal SEO
   - Pemuatan berikutnya lewat TanStack Query

3. Keadaan — semua wajib ada, sesuai DESIGN-SYSTEM.md bagian 7
   - Memuat: skeleton kartu properti yang menyerupai bentuk akhirnya.
     Bukan spinner
   - Parsial: PartialResultNotice yang informatif, menyebutkan berapa penyedia
     sudah menjawab. Hasil baru muncul bertahap tanpa menggeser posisi yang
     sudah dibaca pengguna. Diumumkan lewat aria-live
   - Kosong: penjelasan dan saran mengubah kriteria
   - Error: penjelasan manusiawi dan tombol coba lagi
   - Berisi: normal

4. PropertyCard
   - Foto rasio 4:3 dengan next/image, placeholder blur
   - Nama, lokasi, peringkat, fasilitas ringkas
   - PriceDisplay: harga akhir menonjol lewat ukuran dan ketebalan, bukan warna.
     Rincian pajak di bawahnya dengan ukuran small
   - Label supplier ditampilkan halus, bukan badge mencolok
   - Seluruh kartu dapat diklik, bukan hanya tombolnya
   - Muncul bertahap dengan jeda 30ms untuk sepuluh kartu pertama, menghormati
     prefers-reduced-motion

5. Filter dan pengurutan (FR-06, FR-07)
   - Rentang harga, peringkat bintang, fasilitas
   - Pengurutan: harga, peringkat, relevansi
   - Perubahan filter memperbarui URL
   - Filter aktif ditampilkan sebagai chip yang bisa dilepas satu per satu

6. Halaman detail properti (FR-10, FR-11, FR-12)
   - Galeri foto, deskripsi, fasilitas, lokasi
   - Daftar RatePlanRow. Kebijakan pembatalan dan inklusi WAJIB terlihat tanpa
     perlu diklik — ini kewajiban FR-11, bukan preferensi desain
   - Tawaran dari beberapa supplier untuk kamar yang sama ditampilkan berdampingan
     dengan jelas
   - Lebar konten 960px sesuai dokumen desain
   - Di mobile, aksi utama menempel di bawah layar

7. Kinerja
   - Target NFR-02: hasil pencarian terlihat di bawah 2,5 detik pada koneksi seluler
   - Gambar dioptimalkan, ukuran ditetapkan supaya tidak terjadi pergeseran tata letak
   - Periksa Core Web Vitals dengan Lighthouse dan catat hasilnya

Sebelum menutup step, periksa seluruh butir pada DESIGN-SYSTEM.md bagian 11.

Commit: feat: add search and results experience
```

## Definisi Selesai

- [x] Kriteria pencarian tersimpan di URL dan halaman dapat dibagikan
- [x] Empat keadaan tersedia, ditambah keadaan parsial yang dirancang serius
- [x] Hasil baru muncul tanpa menggeser posisi yang sedang dibaca pengguna
- [x] Kebijakan pembatalan terlihat tanpa diklik pada setiap rate plan
- [x] Filter dan pengurutan memperbarui URL
- [x] Tidak ada pergeseran tata letak saat gambar dimuat — rasio ditetapkan sebelum gambar sampai
- [ ] Lighthouse: LCP, CLS, aksesibilitas — **belum diukur**, butuh gateway menyala
- [x] Seluruh alur dapat dioperasikan dengan keyboard
- [x] Tampilan benar pada lebar 375px — diperiksa di peramban, nol luapan mendatar
- [x] Seluruh butir DESIGN-SYSTEM.md bagian 11 tercentang
- [x] Commit terbuat

### DESIGN-SYSTEM.md bagian 11

- [x] Tidak ada nilai warna mentah — `pnpm verify:tokens`
- [x] Tidak ada jarak di luar skala 4px — skrip yang sama, dan ia menangkap tiga pelanggaran
- [x] Empat keadaan untuk setiap tampilan yang mengambil data
- [x] Bisa dioperasikan penuh dengan papan ketik
- [x] Kontras memenuhi AA — `pnpm verify:contrast`, 30 pasangan
- [x] Terlihat benar pada 375px
- [x] `prefers-reduced-motion` dihormati — seluruh gerak lewat `motion-safe:`
- [x] Tidak ada kartu bersarang
- [x] Warna aksen untuk satu aksi utama per layar — tombol "Cari" di hasil, "Pilih kamar" di detail

## Catatan

Hasil yang menggeser posisi baca memang kesalahan yang paling merusak kesan, dan menyelesaikannya ternyata bukan soal menahan pembaruan — melainkan soal memilih elemen mana yang dijadikan titik acuan.

### Temuan saat mengerjakan step ini

**1. Jangkarnya harus kartu pertama yang TERLIHAT, bukan kartu pertama daftar.** Rancangan pertama menjangkarkan pada kartu pertama, dan itu benar hanya selama pengguna belum menggulir. Setelah menggulir, kartu pertama berada jauh di atas layar; pergeserannya bisa 1000px sementara kartu yang sedang dibaca hanya bergeser 120px, dan koreksinya justru melemparkan pengguna ke tempat yang tidak dimintanya. Diuji sebagai kasus tersendiri.

**2. `useLayoutEffect`, bukan `useEffect`.** Koreksinya harus terjadi sebelum peramban melukis. Dengan `useEffect`, pengguna melihat lompatannya dulu lalu terkoreksi — yang justru lebih mengganggu daripada lompatan itu sendiri.

**3. Uji pertama untuk penjangkaran salah karena mengandaikan efek berjalan setiap render.** Ia bergantung pada `token`, jadi hanya berjalan saat daftarnya berubah. Yang membuat ujinya dapat dipercaya: `getBoundingClientRect` dipalsukan membaca tabel posisi SAAT DIPANGGIL, bukan saat elemen dibuat — sehingga elemen yang sama dapat berada di dua posisi berbeda sebelum dan sesudah perubahan.

**4. `z.coerce.boolean()` adalah jebakan pada query string.** `Boolean('false')` bernilai `true`, jadi `?refundable=false` justru MENYALAKAN penyaringnya. Sama seperti temuan di Step 13, dan kali ini di sisi klien. Yang dipakai: hanya `1` yang menyalakan, dan itu diuji.

**5. Nama tautan kartu hampir menelan seluruh isinya.** Membungkus kartu dengan `<a>` adalah cara termudah membuat seluruh kartu dapat diklik — dan hasilnya satu tautan yang namanya memuat harga, bintang, dan seluruh fasilitas. Di daftar tautan pembaca layar, kartu seperti itu mustahil dikenali. Yang dipakai: tautannya hanya judul, dengan lapisan `::after` tak terlihat yang memperluas wilayah kliknya.

**6. Nama tombol penyaring bintang ternyata "4bintang ke atas".** Angka dan teks sr-only yang bersebelahan digabung tanpa spasi saat nama aksesibelnya dihitung. Ujinya yang menemukannya, bukan mata. Diperbaiki dengan memisahkan tegas: angka untuk mata (`aria-hidden`), kalimat utuh untuk pembaca layar.

**7. Luapan mendatar 15px pada 375px.** Tidak terlihat dari kode dan tidak tertangkap satu pun uji — ditemukan dengan membuka halamannya di peramban dan membandingkan `scrollWidth` dengan `clientWidth`. Penyebabnya label "Urutkan" ditambah pemilih selebar 192px ditambah tombol penyaring. Labelnya kini disembunyikan dari mata pada layar sempit dan tetap ada untuk pembaca layar.

**8. Komponen saran runtuh ketika jawaban API bentuknya lain.** Ditemukan ketika satu uji kebetulan mengembalikan jawaban pencarian untuk kueri saran: `data.cities` menjadi `undefined`, dan yang runtuh bukan kotak isiannya melainkan seluruh halaman. Diperbaiki di tempat yang benar — validasi Zod di `features/search/api.ts`, bukan penjagaan `?? []` di komponen. Yang gagal divalidasi menjadi daftar saran kosong.

**9. Penyaring harga harus dijelaskan bekerja pada harga JUAL.** Sama dengan temuan di Step 13, tetapi konsekuensinya berbeda di sini: panel penyaring menampilkan ambang dalam rupiah, dan ambang itu harus berarti apa yang dilihat pengguna di kartu — bukan harga penyedia yang tidak pernah ditampilkan.

**10. `?: T` dan `?: T | undefined` berbeda di bawah `exactOptionalPropertyTypes`.** Seluruh bidang opsional pada tipe jawaban API ditulis ulang dengan `| undefined`: yang datang dari JSON memang bidang yang ADA tetapi bernilai `undefined`, dan menulis `?: T` saja membuat bentuk yang sah di kawat tidak dapat diwakili tipenya.

**11. Chip penyaring diturunkan dari kriteria, bukan disimpan sendiri.** Itu yang membuat mustahil ada chip yang tertinggal setelah penyaringnya dilepas lewat panel — dan membuat panel serta chip mustahil saling bertentangan, karena keduanya membaca sumber yang sama.

### Yang belum diverifikasi

**Lighthouse belum dijalankan.** Pengukuran LCP dan CLS yang bermakna membutuhkan hasil pencarian sungguhan — dan itu membutuhkan gateway, search-service, supplier-service, serta pricing-service menyala. Docker masih mati.

Yang sudah diperiksa di peramban sungguhan, dengan build produksi: tata letak 375px tanpa luapan mendatar, tata letak dua kolom pada desktop dengan panel penyaring 260px, keadaan memuat, keadaan galat, chip penyaring yang terbaca dari URL, dan tidak ada satu pun galat React maupun ketidakcocokan hidrasi di konsol.

Yang sudah terbukti lewat 213 uji: perjalanan bolak-balik kriteria di URL, penolakan kriteria yang tidak lengkap, kelima keadaan halaman hasil, penjangkaran posisi baca dalam enam keadaan berbeda, seluruh papan ketik combobox, kebijakan pembatalan yang terlihat tanpa diklik, dan harga jual yang tidak pernah menampilkan harga penyedia.

Jalankan ini setelah Docker menyala:

```bash
pnpm infra:up
pnpm --filter @tbe/mock-supplier dev
pnpm --filter @tbe/supplier-service dev
pnpm --filter @tbe/pricing-service dev
pnpm --filter @tbe/search-service dev
pnpm --filter @tbe/api-gateway dev
pnpm --filter @tbe/web build
pnpm --filter @tbe/web start
```

Lalu ukur, dan catat angkanya di `docs/evidence/`:

```bash
npx lighthouse "http://localhost:3000/cari?kota=Bali&mulai=2026-11-10&selesai=2026-11-12" \
  --preset=desktop --output=json --output-path=docs/evidence/lighthouse-cari.json
```

Target NFR-02: LCP di bawah 2,5 detik, CLS di bawah 0,1, aksesibilitas ≥ 95.

CLS yang di atas 0,1 hampir pasti berasal dari satu tempat: kartu properti yang tingginya berubah ketika nama hotel panjang membungkus ke baris kedua. Skeleton-nya dibuat menyerupai bentuk akhir justru untuk mencegah itu, tetapi tinggi barisnya belum pernah dibandingkan dengan data sungguhan.

Yang juga layak diperiksa saat itu: apakah penjangkaran posisi baca benar-benar bekerja dengan penyedia lambat sungguhan. Buka hasil pencarian, gulir ke kartu ketiga, dan tunggu LUNA menjawab. Halaman yang melompat berarti tokennya tidak berubah saat daftar diperbarui — periksa `ResultsList`.
