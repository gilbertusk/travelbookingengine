# Step 04 — Mock supplier service

**Fase 0** · Milestone 1 · Estimasi 6 jam · Prasyarat: Step 03

## Tujuan

Membangun lingkungan supplier tiruan yang bisa dibuat gagal sesuai kehendak. Ini **step paling penting di seluruh project**. Setiap klaim ketahanan di README nanti bersandar pada kualitas simulasi ini. Supplier tiruan yang hanya menunda balasan tidak membuktikan apa pun.

## Prompt

```
Buat apps/mock-supplier, layanan yang mensimulasikan lima supplier hotel dengan
karakteristik yang berbeda-beda.

Baca docs/plan/CONVENTIONS.md dan PRD Bab 8 (glosarium domain) terlebih dahulu.
Istilah yang dipakai harus mengikuti glosarium: property, room type, rate plan,
availability, hold, booking reference.

Lima supplier yang disimulasikan:

| Kode | Protokol | Mata uang | Latensi p50 | Perilaku khas |
|------|----------|-----------|-------------|---------------|
| SKY  | REST JSON | IDR | 180ms | Cepat dan stabil, inventaris paling lengkap |
| NOVA | REST JSON | USD | 600ms | Perlu konversi mata uang, format tanggal ISO |
| ORBIT| SOAP XML  | IDR | 900ms | Respons XML, penamaan field sama sekali berbeda |
| LUNA | REST JSON | IDR | 2800ms | Lambat, sering melewati batas waktu |
| ZEPH | REST JSON | USD | 400ms | Tidak stabil, sekitar 15% permintaan gagal |

Setiap supplier mengekspos operasi berikut, dengan bentuk request dan response
yang BERBEDA antar supplier. Perbedaan ini disengaja — inilah yang menguji
lapisan adapter nanti:

1. search — cari ketersediaan berdasarkan kota, rentang tanggal, jumlah tamu
2. priceCheck — verifikasi harga satu rate plan, mengembalikan harga terkini
3. hold — tahan satu rate plan, mengembalikan token hold dan waktu kedaluwarsa
4. book — konfirmasi pemesanan, mengembalikan booking reference
5. cancel — batalkan pemesanan
6. getBooking — ambil status pemesanan berdasarkan booking reference

Perilaku yang WAJIB disimulasikan dengan benar:

- Ketersediaan terbatas per rate plan per tanggal. Pemesanan melebihi ketersediaan
  ditolak dengan galat yang jelas
- Hold mengurangi ketersediaan sementara dan dilepas otomatis saat kedaluwarsa
- Harga berubah secara acak pada sebagian kecil priceCheck, sekitar 10%,
  supaya alur rate change bisa diuji
- book bersifat idempoten terhadap idempotency key: permintaan berulang dengan
  kunci sama mengembalikan booking reference yang sama, bukan pemesanan baru
- getBooking memungkinkan pemulihan setelah timeout — ini yang membuat US-05
  bisa diimplementasikan

Panel kendali kegagalan (ini bagian terpenting):

Buat endpoint admin untuk menyuntikkan kondisi pada supplier mana pun saat berjalan:
- POST /admin/:supplier/latency  — set latensi tetap atau rentang
- POST /admin/:supplier/failure  — set tingkat kegagalan dan jenisnya:
  timeout, 500, 503, koneksi ditolak, respons cacat, respons terpotong
- POST /admin/:supplier/down     — matikan supplier sepenuhnya
- POST /admin/:supplier/up       — pulihkan
- POST /admin/:supplier/price-drift — atur peluang harga berubah saat priceCheck
- POST /admin/reset              — kembalikan seluruh supplier ke normal
- GET  /admin/state              — lihat kondisi seluruh supplier

Data:
- Bangkitkan katalog properti yang masuk akal untuk 8 kota di Indonesia dan Asia
  Tenggara, sekitar 40 properti per kota, masing-masing 2–4 room type dengan
  2–3 rate plan
- Properti yang sama muncul di lebih dari satu supplier dengan harga berbeda dan
  penamaan sedikit berbeda — ini yang akan menguji deduplikasi di Step 13
- Gunakan seed tetap supaya data konsisten antar proses
- Simpan di memori, tidak perlu database

Ketentuan:
- Satu proses, lima supplier dibedakan lewat prefix path: /sky, /nova, /orbit, /luna, /zeph
- Struktur kode mengikuti CONVENTIONS.md
- Tulis test untuk: idempotency book, penolakan saat ketersediaan habis,
  pelepasan hold saat kedaluwarsa, dan bahwa setiap suntikan kegagalan benar-benar
  berpengaruh
- Buat apps/mock-supplier/README.md berisi contoh request tiap supplier dan
  contoh perintah penyuntikan kegagalan

Setelah selesai, commit: feat: add mock supplier service with failure injection
```

## Definisi Selesai

- [ ] Lima supplier dapat dihubungi dan bentuk responsnya benar-benar berbeda satu sama lain
- [ ] ORBIT mengembalikan XML yang sah dengan penamaan field yang berbeda
- [ ] NOVA dan ZEPH mengembalikan harga dalam USD
- [ ] Ketersediaan terbatas ditegakkan — pemesanan berlebih ditolak
- [ ] `book` idempoten terhadap idempotency key — dibuktikan dengan test
- [ ] `getBooking` dapat dipakai memulihkan status setelah timeout
- [ ] Seluruh jenis penyuntikan kegagalan berfungsi dan dibuktikan dengan test
- [ ] Data properti konsisten antar restart karena memakai seed tetap
- [ ] README berisi contoh perintah yang bisa disalin langsung

## Catatan

Godaan terbesar di step ini adalah membuat kelima supplier hampir sama untuk menghemat waktu. Jangan. Perbedaan protokol, mata uang, dan penamaan field adalah satu-satunya hal yang membuat lapisan adapter di Step 10 punya alasan untuk ada.

### Temuan saat mengerjakan step ini

**1. Aturan boundary menangkap pelanggaran arsitektur yang nyata.** Berkas perangkaian aplikasi awalnya diletakkan di `http/`, sehingga ia mengimpor dari `infrastructure/` — persis yang dilarang. Dua perbaikan menyusul: perangkaian dipindah ke `src/composition/`, dan `RefIndex` dinaikkan dari detail infrastruktur menjadi port di `application/`. Tanpa penegakan otomatis, kebocoran ini tidak akan pernah terlihat.

**2. Factory router melanggar batas 50 baris, dan itu benar.** Enam rute dengan handler inline memang tidak terbaca. Pola yang ditetapkan: **factory hanya mendaftarkan, setiap rute punya pabrik handler sendiri**. Pola ini berlaku untuk seluruh service berikutnya.

**3. `return voidFunction()` melanggar `no-confusing-void-expression`.** Pola `if (!ok) return sendFailure(res, err)` harus ditulis sebagai blok dengan `return` tersendiri. Menyebalkan, tetapi benar — `return` yang tampak mengembalikan sesuatu padahal tidak adalah sumber kebingungan nyata.

**4. supertest mengurai JSON sendiri, dan itu menyembunyikan suntikan `malformed`.** Pengujian gagal dengan `SyntaxError` sebelum sampai ke assertion. Butuh `.buffer(true).parse(...)` untuk mengambil badan respons mentah.

**5. Menyetel sumber keacakan ke nol membuat SELURUH supplier gagal**, bukan hanya yang disuntik — LUNA dan ZEPH punya peluang kegagalan bawaan. Uji isolasi antar supplier jadi tidak berarti. Cara yang benar: suntik dengan `rate: 1` dan biarkan keacakannya tinggi.

**6. Urutan blok pada konfigurasi flat ESLint menentukan.** Pengecualian aturan boundary untuk berkas uji tidak berpengaruh apa pun ketika diletakkan sebelum blok yang mengaktifkannya — tanpa galat, tanpa peringatan. Harus di paling akhir.

### Estimasi

Diperkirakan 6 jam. Kenyataannya **jauh lebih lama** — bagian implementasi berjalan lancar, tetapi menegakkan konvensi kode (batas ukuran fungsi, arah ketergantungan, larangan `any`) pada kode sebanyak ini memakan waktu sebanding dengan menulisnya. Perkirakan 12–16 jam untuk step sejenis, dan sesuaikan perkiraan step-step berikutnya yang menyentuh lapisan HTTP.
