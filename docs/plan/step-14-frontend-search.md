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

- [ ] Kriteria pencarian tersimpan di URL dan halaman dapat dibagikan
- [ ] Empat keadaan tersedia, ditambah keadaan parsial yang dirancang serius
- [ ] Hasil baru muncul tanpa menggeser posisi yang sedang dibaca pengguna
- [ ] Kebijakan pembatalan terlihat tanpa diklik pada setiap rate plan
- [ ] Filter dan pengurutan memperbarui URL
- [ ] Tidak ada pergeseran tata letak saat gambar dimuat
- [ ] Lighthouse: LCP di bawah 2,5 detik, CLS di bawah 0,1, aksesibilitas ≥ 95
- [ ] Seluruh alur dapat dioperasikan dengan keyboard
- [ ] Tampilan benar pada lebar 375px
- [ ] Seluruh butir DESIGN-SYSTEM.md bagian 11 tercentang
- [ ] Commit terbuat

## Catatan

Hasil yang menggeser posisi saat supplier lambat menjawab adalah kesalahan yang paling merusak kesan. Pengguna sedang membaca kartu ketiga, lalu kartu baru menyisip di atas dan mendorong semuanya. Sisipkan hasil baru di posisi urutannya tanpa mengubah offset gulir.
