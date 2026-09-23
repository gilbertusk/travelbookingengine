# Travel Booking Engine — OTA Hotel Aggregator

**Status:** DRAFT — requirements only
**Versi:** 1.0
**Tanggal:** 2026-09-23
**Tipe:** Portfolio project (simulated product)

---

## 1. Ringkasan Eksekutif

Platform agregator pemesanan hotel yang menggabungkan inventaris dari beberapa supplier pihak ketiga, menyajikannya sebagai satu hasil pencarian, dan menangani seluruh alur pemesanan sampai penerbitan e-voucher.

Karakter yang membedakan sistem ini dari e-commerce biasa: **inventaris tidak dimiliki sendiri.** Stok berada di pihak ketiga yang lambat, formatnya berbeda-beda, harganya berubah tanpa pemberitahuan, dan sewaktu-waktu bisa mati. Seluruh kompleksitas teknis produk ini berasal dari kenyataan tersebut.

Produk ini dibangun sebagai artefak portofolio untuk melamar posisi backend engineer. Karena itu PRD ini memiliki dua lapis tujuan yang dilacak terpisah: tujuan produk (Bab 3.1) dan tujuan portofolio (Bab 3.2).

---

## 2. Latar Belakang & Masalah

### 2.1 Masalah produk yang disimulasikan

Pencari akomodasi harus membuka beberapa situs pemesanan satu per satu untuk membandingkan harga hotel yang sama, karena setiap penyedia memiliki inventaris dan harga berbeda untuk properti yang identik. Proses ini memakan waktu dan tetap tidak memberi keyakinan bahwa harga yang didapat adalah yang terbaik.

Biaya kalau dibiarkan: pengguna membayar lebih mahal dari yang perlu, atau menghabiskan waktu berlebihan untuk perbandingan manual yang tidak menyeluruh.

### 2.2 Masalah sesungguhnya yang dipecahkan

Agregasi terlihat sederhana dari luar, tetapi menghadirkan empat masalah teknis yang tidak muncul pada sistem yang memiliki inventarisnya sendiri:

1. **Latensi tidak seragam.** Supplier merespons antara 200ms sampai lebih dari 3 detik, sebagian sedang tidak dapat dihubungi. Pengguna tidak bersedia menunggu yang paling lambat.
2. **Harga yang cepat basi.** Mempercepat pencarian menuntut caching, tetapi harga hasil cache bisa sudah berbeda dengan harga sebenarnya di supplier saat pengguna membayar.
3. **Transaksi lintas sistem yang bisa gagal di tengah.** Pembayaran berhasil sementara konfirmasi ke supplier gagal berarti uang sudah diambil tanpa kamar yang terjamin.
4. **Ketidakpastian hasil pada kegagalan jaringan.** Ketika permintaan konfirmasi ke supplier timeout, status pemesanan tidak diketahui. Percobaan ulang yang naif menghasilkan pemesanan ganda dan kerugian finansial nyata.

### 2.3 Kenapa sekarang

Tidak ada dorongan pasar. Pemilihan domain ini disengaja karena keempat masalah di atas merupakan persoalan sistem terdistribusi yang otentik, bukan kompleksitas yang dibuat-buat demi membenarkan pemakaian arsitektur microservices.

---

## 3. Tujuan

### 3.1 Tujuan produk

| # | Tujuan |
|---|---|
| G1 | Pengguna memperoleh hasil pencarian tergabung dari banyak supplier dalam waktu yang terasa seketika |
| G2 | Pengguna tidak pernah dibebani harga yang berbeda dari yang dikonfirmasinya |
| G3 | Pengguna tidak pernah kehilangan uang akibat kegagalan sistem internal maupun kegagalan supplier |
| G4 | Pengguna memperoleh bukti pemesanan yang sah dan dapat membatalkan sesuai kebijakan yang berlaku |

### 3.2 Tujuan portofolio

| # | Tujuan |
|---|---|
| P1 | Menunjukkan penguasaan pola sistem terdistribusi: saga dengan kompensasi, idempotency, circuit breaker, caching berlapis |
| P2 | Menunjukkan pemisahan peran message broker yang beralasan, bukan sekadar pemakaian teknologi populer |
| P3 | Menyediakan bukti kuantitatif ketahanan sistem, bukan klaim naratif |
| P4 | Menunjukkan kemampuan mengambil dan mendokumentasikan keputusan arsitektur beserta alternatif yang ditolak |
| P5 | Menghasilkan sistem yang dapat didemonstrasikan tanpa perlu instalasi oleh penilai |

---

## 4. Bukti

**Status: ASUMSI — belum divalidasi.**

Tidak ada riset pengguna, tiket dukungan, maupun data analitik yang mendasari PRD ini. Masalah produk pada Bab 2.1 diturunkan dari pengamatan umum terhadap perilaku pasar OTA, bukan dari bukti primer.

Hal ini dapat diterima karena tujuan sesungguhnya bersifat teknis (Bab 3.2). Yang perlu dijaga: tujuan portofolio pada Bab 3.2 **harus** diverifikasi dengan bukti terukur, dan bukti tersebut didefinisikan pada Bab 7.2.

Pernyataan yang tidak boleh dibuat di dokumentasi mana pun tanpa validasi: klaim mengenai kebutuhan pasar, ukuran peluang, atau kesediaan pengguna membayar.

---

## 5. Pengguna

### 5.1 Pengguna utama (disimulasikan)

**Pemesan perjalanan mandiri.** Memesan akomodasi untuk dirinya sendiri atau kelompok kecil. Sensitif terhadap harga, membandingkan beberapa sumber sebelum memutuskan, dan mengharapkan konfirmasi instan.

Pemicu kebutuhan: memiliki tanggal dan kota tujuan yang sudah pasti, membutuhkan akomodasi dengan harga terbaik yang dapat ditemukan.

### 5.2 Pengguna sekunder

**Operator platform.** Mengelola daftar supplier, mengatur aturan markup, memantau kesehatan supplier, dan meninjau pemesanan yang bermasalah.

### 5.3 Audiens sesungguhnya

**Backend engineer atau engineering manager yang menilai portofolio.** Berinteraksi dengan sistem melalui README, diagram arsitektur, catatan keputusan arsitektur, hasil uji beban, dan demonstrasi langsung. Waktu perhatian yang tersedia diperkirakan kurang dari sepuluh menit pada kontak pertama.

Implikasi terhadap perancangan: bukti kuantitatif harus dapat ditemukan tanpa membaca kode, dan demonstrasi harus dapat diakses tanpa proses instalasi.

### 5.4 Bukan untuk

| Segmen | Alasan dikecualikan |
|---|---|
| Agen perjalanan B2B | Membutuhkan harga bertingkat per mitra, limit kredit, dan termin pembayaran |
| Pemesanan korporat | Membutuhkan alur persetujuan dan kebijakan perjalanan perusahaan |
| Pemesanan grup besar | Membutuhkan negosiasi harga dan alokasi kamar manual |
| Pengguna yang mencari tiket transportasi | Di luar lingkup MVP, lihat Bab 11 |

---

## 6. Hipotesis

Kami percaya bahwa **sistem agregasi dengan fan-out berbatas waktu, caching berlapis, dan saga pemesanan yang memiliki langkah kompensasi** akan **menyajikan hasil pencarian multi-supplier secara cepat sekaligus menjamin tidak ada pengguna yang kehilangan uang ketika supplier gagal** bagi **pemesan perjalanan mandiri**.

Kami akan tahu hipotesis ini benar ketika:

- Pencarian tetap mengembalikan hasil di bawah 800ms pada persentil 95 meskipun satu supplier sengaja dibuat merespons 3 detik dan satu supplier lainnya dimatikan; **dan**
- Pada pengujian 1.000 pemesanan serentak terhadap 10 kamar tersedia, tepat 10 pemesanan berhasil, tanpa pemesanan ganda; **dan**
- Pada pengujian dengan supplier dimatikan tepat setelah pembayaran berhasil, 100% dana dikembalikan secara otomatis tanpa intervensi manual.

---

## 7. Metrik Keberhasilan

### 7.1 Metrik produk

| ID | Metrik | Target | Cara diukur |
|---|---|---|---|
| M1 | Latensi pencarian p95 | < 800ms | Uji beban dengan profil supplier campuran |
| M2 | Latensi pencarian p99 | < 1.500ms | Uji beban |
| M3 | Rasio cache hit pencarian | > 70% | Metrik aplikasi pada pola pencarian realistis |
| M4 | Tingkat keberhasilan pemesanan | > 99,5% dari pembayaran yang berhasil | Event pemesanan |
| M5 | Pemesanan ganda | 0 | Uji beban konkurensi |
| M6 | Pembayaran tanpa pemesanan terkonfirmasi dan tanpa refund | 0 | Rekonsiliasi otomatis |
| M7 | Waktu penerbitan voucher setelah konfirmasi | < 30 detik p95 | Selisih waktu event |

### 7.2 Metrik portofolio

| ID | Metrik | Target | Cara diukur |
|---|---|---|---|
| M8 | Cakupan uji otomatis | >= 80% | Laporan coverage |
| M9 | Uji integrasi saga menggunakan infrastruktur sungguhan | 100% jalur kompensasi tercakup | Daftar skenario uji |
| M10 | Catatan keputusan arsitektur terdokumentasi | >= 5 | Isi direktori dokumentasi |
| M11 | Pemulihan setelah supplier dimatikan di tengah alur | 100% pemesanan terselesaikan atau dikembalikan | Uji chaos |
| M12 | Demonstrasi dapat diakses tanpa instalasi | Tersedia | URL publik aktif |

---

## 8. Glosarium Domain

Istilah berikut mengikat sepanjang dokumen dan seluruh implementasi.

| Istilah | Definisi |
|---|---|
| **Supplier** | Pihak ketiga penyedia inventaris hotel. Setiap supplier memiliki antarmuka, format data, mata uang, dan karakteristik latensi yang berbeda |
| **Property** | Satu hotel sebagai entitas fisik, dapat ditawarkan oleh lebih dari satu supplier |
| **Room Type** | Jenis kamar dalam sebuah property |
| **Rate Plan** | Kombinasi harga dan syarat untuk satu room type pada rentang tanggal tertentu. Satu room type dapat memiliki banyak rate plan yang berbeda pada sifat refundable dan inklusi sarapan |
| **Availability** | Ketersediaan sebuah rate plan pada rentang tanggal tertentu. Bukan angka stok tunggal |
| **Hold** | Penahanan sementara sebuah rate plan untuk satu calon pemesan, dengan batas waktu |
| **Price Check** | Verifikasi harga langsung ke supplier segera sebelum pembayaran, tidak boleh dilayani dari cache |
| **Rate Change** | Perbedaan harga antara yang ditampilkan dan yang diverifikasi. Merupakan kondisi normal, bukan kegagalan |
| **Markup** | Selisih antara harga supplier dan harga jual kepada pengguna |
| **Booking Reference** | Pengenal pemesanan yang diterbitkan supplier. Merupakan bukti pemesanan yang sah, berbeda dari pengenal internal |
| **Cancellation Policy** | Aturan pengembalian dana yang melekat pada rate plan, umumnya berbasis tenggat waktu |
| **Compensation** | Tindakan pembalik atas langkah yang sudah terlanjur dijalankan ketika langkah berikutnya gagal |
| **Reconciliation** | Proses berkala pencocokan catatan pemesanan internal dengan catatan supplier |

---

## 9. Lingkup MVP

MVP adalah **agregator hotel saja**, dengan alur lengkap dari pencarian sampai pembatalan.

### 9.1 Kebutuhan fungsional

Prioritas mengikuti MoSCoW. Hanya **Must** yang membentuk definisi selesai untuk MVP.

#### Pencarian dan penemuan

| ID | Kebutuhan | Prioritas |
|---|---|---|
| FR-01 | Pengguna dapat mencari akomodasi berdasarkan kota, tanggal masuk, tanggal keluar, dan jumlah tamu | Must |
| FR-02 | Sistem mengumpulkan hasil dari seluruh supplier aktif secara paralel | Must |
| FR-03 | Sistem mengembalikan hasil parsial ketika sebagian supplier melampaui batas waktu, disertai keterangan bahwa hasil belum lengkap | Must |
| FR-04 | Sistem menggabungkan property yang sama dari supplier berbeda menjadi satu entri dan menampilkan harga terendah | Must |
| FR-05 | Sistem menyajikan harga akhir yang sudah termasuk markup dan pajak, bukan harga supplier | Must |
| FR-06 | Pengguna dapat menyaring hasil berdasarkan rentang harga, peringkat bintang, dan fasilitas | Should |
| FR-07 | Pengguna dapat mengurutkan hasil berdasarkan harga, peringkat, atau relevansi | Should |
| FR-08 | Pengguna menerima saran otomatis nama kota atau property saat mengetik | Could |
| FR-09 | Pengguna dapat melihat lokasi property pada peta | Could |

#### Detail dan pemilihan

| ID | Kebutuhan | Prioritas |
|---|---|---|
| FR-10 | Pengguna dapat melihat detail property beserta seluruh rate plan yang tersedia | Must |
| FR-11 | Setiap rate plan menampilkan kebijakan pembatalan secara eksplisit sebelum pemesanan | Must |
| FR-12 | Setiap rate plan menampilkan inklusi seperti sarapan dan sifat refundable | Must |

#### Pemesanan

| ID | Kebutuhan | Prioritas |
|---|---|---|
| FR-13 | Sistem melakukan price check langsung ke supplier sebelum meminta pembayaran | Must |
| FR-14 | Ketika harga berubah, sistem menghentikan alur, menampilkan harga baru, dan menunggu persetujuan eksplisit pengguna | Must |
| FR-15 | Sistem menahan rate plan terpilih dengan batas waktu yang ditampilkan kepada pengguna | Must |
| FR-16 | Hold yang melewati batas waktu dilepaskan secara otomatis tanpa intervensi | Must |
| FR-17 | Pengguna mengisi data tamu dan kontak sebelum pembayaran | Must |
| FR-18 | Sistem menolak permintaan pemesanan berulang yang identik tanpa membuat pemesanan ganda | Must |

#### Pembayaran

| ID | Kebutuhan | Prioritas |
|---|---|---|
| FR-19 | Pengguna dapat membayar melalui penyedia pembayaran | Must |
| FR-20 | Sistem memproses notifikasi pembayaran secara idempoten, aman terhadap pengiriman berulang | Must |
| FR-21 | Pembayaran yang berhasil memicu konfirmasi ke supplier secara asinkron | Must |
| FR-22 | Kegagalan konfirmasi supplier yang bersifat permanen memicu pengembalian dana otomatis | Must |
| FR-23 | Pengguna menerima pemberitahuan jelas ketika pemesanan gagal beserta status pengembalian dananya | Must |

#### Pasca-pemesanan

| ID | Kebutuhan | Prioritas |
|---|---|---|
| FR-24 | Pengguna menerima e-voucher berisi booking reference supplier | Must |
| FR-25 | Pengguna dapat melihat daftar dan detail pemesanannya | Must |
| FR-26 | Pengguna dapat memantau status pemesanan yang sedang diproses secara langsung tanpa memuat ulang halaman | Should |
| FR-27 | Pengguna dapat membatalkan pemesanan dan menerima pengembalian dana sesuai kebijakan rate plan | Must |
| FR-28 | Pengguna menerima pemberitahuan melalui surel pada setiap perubahan status penting | Should |

#### Operasi

| ID | Kebutuhan | Prioritas |
|---|---|---|
| FR-29 | Operator dapat menambah, menonaktifkan, dan mengatur konfigurasi supplier | Must |
| FR-30 | Operator dapat mengatur aturan markup | Must |
| FR-31 | Operator dapat melihat kesehatan dan performa tiap supplier | Should |
| FR-32 | Sistem menyediakan mekanisme simulasi kegagalan supplier untuk keperluan pengujian | Must |
| FR-33 | Sistem menjalankan rekonsiliasi berkala antara pemesanan internal dan catatan supplier | Should |

#### Akun

| ID | Kebutuhan | Prioritas |
|---|---|---|
| FR-34 | Pengguna dapat mendaftar dan masuk menggunakan surel dan kata sandi | Must |
| FR-35 | Pengguna dapat mengelola profil dasar | Could |

### 9.2 Kebutuhan non-fungsional

| ID | Kategori | Kebutuhan |
|---|---|---|
| NFR-01 | Performa | Pencarian memenuhi target M1 dan M2 pada kondisi supplier campuran |
| NFR-02 | Performa | Halaman hasil pencarian dapat dilihat pengguna dalam waktu kurang dari 2,5 detik pada koneksi seluler |
| NFR-03 | Ketahanan | Kegagalan satu supplier tidak boleh menurunkan latensi maupun ketersediaan alur pencarian |
| NFR-04 | Ketahanan | Supplier yang tidak sehat berhenti dihubungi secara otomatis dan dipulihkan secara bertahap |
| NFR-05 | Ketahanan | Kegagalan satu layanan non-kritis tidak boleh menggagalkan alur pemesanan |
| NFR-06 | Konsistensi | Setiap alur pemesanan berakhir pada salah satu keadaan final: terkonfirmasi, dibatalkan dengan dana kembali, atau ditandai untuk peninjauan manual. Tidak ada keadaan menggantung |
| NFR-07 | Konsistensi | Seluruh operasi yang berhubungan dengan uang dan supplier bersifat idempoten |
| NFR-08 | Konsistensi | Perhitungan nilai uang tidak boleh menggunakan aritmetika bilangan pecahan biner |
| NFR-09 | Konsistensi | Tanggal masuk dan keluar diperlakukan sebagai tanggal lokal properti, bukan titik waktu universal |
| NFR-10 | Auditabilitas | Setiap perubahan status pemesanan tercatat permanen dan dapat ditelusuri |
| NFR-11 | Keamanan | Kata sandi disimpan menggunakan fungsi hash yang dirancang untuk kata sandi |
| NFR-12 | Keamanan | Tidak ada kredensial tertanam di dalam kode sumber |
| NFR-13 | Keamanan | Seluruh masukan dari pengguna maupun supplier divalidasi di batas sistem |
| NFR-14 | Keamanan | Pembatasan laju diterapkan pada antarmuka publik dan pada panggilan keluar ke supplier |
| NFR-15 | Keamanan | Pesan galat tidak mengungkap detail internal sistem |
| NFR-16 | Observabilitas | Satu permintaan pengguna dapat ditelusuri melintasi seluruh layanan yang dilewatinya |
| NFR-17 | Observabilitas | Latensi, tingkat galat, dan status pemutus sirkuit setiap supplier terekam sebagai metrik |
| NFR-18 | Kualitas | Cakupan uji otomatis memenuhi target M8 |
| NFR-19 | Kualitas | Jalur kompensasi diuji menggunakan infrastruktur sungguhan, bukan tiruan |
| NFR-20 | Skalabilitas | Seluruh layanan bersifat stateless dan dapat digandakan secara horizontal |
| NFR-21 | Portabilitas | Seluruh sistem dapat dijalankan di mesin pengembang dengan satu perintah |

### 9.3 Cerita pengguna kritis

Hanya jalur yang menentukan keberhasilan hipotesis yang dirinci di sini.

**US-01 — Pencarian saat sebagian supplier bermasalah**

> Sebagai pemesan perjalanan, saya ingin tetap melihat pilihan hotel dengan cepat walaupun sebagian penyedia sedang bermasalah, agar saya tidak perlu menunggu tanpa kepastian.

Kriteria penerimaan:
- **Diberikan** lima supplier aktif, satu di antaranya merespons melebihi batas waktu dan satu lainnya tidak dapat dihubungi, **ketika** pengguna melakukan pencarian, **maka** hasil dari supplier yang sehat ditampilkan dalam batas target M1
- **Dan** pengguna diberi keterangan bahwa hasil belum mencakup seluruh penyedia
- **Dan** supplier yang tidak dapat dihubungi tidak dihubungi lagi pada pencarian berikutnya sampai masa pemulihannya tiba
- **Dan** hasil dari supplier lambat tetap diterima di latar belakang dan tersedia pada pencarian berikutnya

**US-02 — Harga berubah saat akan membayar**

> Sebagai pemesan perjalanan, saya ingin diberi tahu bila harga berubah sebelum saya membayar, agar saya tidak merasa ditipu.

Kriteria penerimaan:
- **Diberikan** pengguna memilih rate plan seharga X, **ketika** verifikasi ke supplier mengembalikan harga Y yang berbeda, **maka** alur pembayaran dihentikan
- **Dan** pengguna melihat harga lama, harga baru, dan selisihnya secara eksplisit
- **Dan** pembayaran hanya dapat dilanjutkan setelah pengguna menyetujui harga baru
- **Dan** pengguna tidak pernah dibebani nilai selain yang terakhir disetujuinya

**US-03 — Supplier gagal setelah pembayaran berhasil**

> Sebagai pemesan perjalanan, saya ingin uang saya kembali secara otomatis bila pemesanan gagal, agar saya tidak perlu mengejar pengembalian dana.

Kriteria penerimaan:
- **Diberikan** pembayaran berhasil, **ketika** konfirmasi ke supplier gagal secara permanen setelah seluruh percobaan ulang habis, **maka** pengembalian dana dimulai tanpa intervensi manual
- **Dan** hold dilepaskan
- **Dan** pengguna menerima pemberitahuan berisi alasan kegagalan dan status pengembalian dana
- **Dan** pemesanan berakhir pada keadaan final, tidak menggantung
- **Dan** seluruh rangkaian peristiwa dapat ditelusuri dari catatan audit

**US-04 — Pemesanan serentak pada ketersediaan terbatas**

> Sebagai operator platform, saya ingin memastikan tidak ada kamar terjual melebihi ketersediaan, agar platform tidak menanggung kerugian dan reputasi buruk.

Kriteria penerimaan:
- **Diberikan** sebuah rate plan dengan ketersediaan N, **ketika** M permintaan pemesanan tiba bersamaan dengan M jauh lebih besar dari N, **maka** tepat N pemesanan mencapai keadaan terkonfirmasi
- **Dan** sisanya menerima penolakan yang jelas tanpa pernah dibebani pembayaran
- **Dan** tidak ada pemesanan ganda pada sisi supplier

**US-05 — Percobaan ulang pada kondisi tidak pasti**

> Sebagai operator platform, saya ingin sistem tidak membuat pemesanan ganda ketika jaringan bermasalah, agar tidak terjadi kerugian finansial.

Kriteria penerimaan:
- **Diberikan** permintaan konfirmasi ke supplier melampaui batas waktu tanpa jawaban, **ketika** sistem menindaklanjuti, **maka** sistem terlebih dahulu memastikan status sebenarnya di supplier sebelum mencoba ulang
- **Dan** bila pemesanan ternyata sudah terbentuk, sistem mengadopsinya alih-alih membuat yang baru
- **Dan** hasil akhirnya tetap satu pemesanan

---

## 10. Milestone Pengiriman

Setiap milestone menghasilkan perubahan yang dapat diamati dan dibuktikan. Perkiraan waktu mengasumsikan pengerjaan paruh waktu.

| # | Milestone | Hasil yang dapat diamati | Estimasi | Status | Plan |
|---|---|---|---|---|---|
| 1 | Lingkungan supplier tiruan | Lima supplier tiruan berkarakter berbeda dapat dihubungi, dengan kendali penyuntikan latensi dan kegagalan | 1 minggu | pending | — |
| 2 | Fondasi platform | Seluruh infrastruktur berjalan dengan satu perintah; pengguna dapat mendaftar dan masuk | 2 minggu | pending | — |
| 3 | Pencarian teragregasi | Pengguna memperoleh hasil tergabung yang memenuhi M1, M2, dan M3 pada kondisi supplier campuran | 2–3 minggu | pending | — |
| 4 | Pemesanan dan pembayaran | Pengguna dapat memesan dan membayar; kegagalan supplier menghasilkan pengembalian dana otomatis; M4, M5, dan M6 terpenuhi | 3 minggu | pending | — |
| 5 | Voucher, pembatalan, pemberitahuan | Pengguna menerima voucher, dapat membatalkan sesuai kebijakan, dan menerima pemberitahuan | 1–2 minggu | pending | — |
| 6 | Pembuktian dan publikasi | Hasil uji beban, uji chaos, penelusuran terdistribusi, catatan keputusan arsitektur, dan demonstrasi publik tersedia | 2 minggu | pending | — |

Total perkiraan: **11–13 minggu**.

Milestone 1 sengaja ditempatkan paling awal. Tanpa lingkungan supplier yang dapat dibuat gagal sesuai kehendak, tidak satu pun klaim ketahanan pada Bab 7 dapat dibuktikan.

---

## 11. Di Luar Lingkup

| Item | Alasan |
|---|---|
| Tiket pesawat, kereta, dan transportasi lain | Domainnya menambah kompleksitas aturan bisnis tanpa menambah kompleksitas sistem terdistribusi. Merupakan penyebab paling umum project sejenis tidak selesai |
| Paket wisata dan aktivitas | Sama seperti di atas |
| Program loyalitas dan poin | Tidak menguji satu pun hipotesis pada Bab 6 |
| Ulasan dan penilaian pengguna | Fitur konten, bukan fitur sistem |
| Percakapan dengan layanan pelanggan | Domain realtime yang terpisah |
| Pembayaran dengan mata uang lokal penuh | Konversi mata uang tetap ada, tetapi tanpa gerbang pembayaran multi-mata uang sungguhan |
| Aplikasi seluler native | Antarmuka web responsif sudah memadai untuk demonstrasi |
| Panel operator yang dipoles | Fungsional saja, tanpa investasi pada tampilan |
| Orkestrasi kontainer tingkat produksi | Menambah waktu pengerjaan tanpa menambah nilai pembuktian pada tahap ini |
| Personalisasi dan rekomendasi | Bukan bagian dari hipotesis |

---

## 12. Batasan Teknis

Batasan berikut merupakan ketentuan awal project, bukan hasil analisis kebutuhan. Dicatat di sini agar pembaca memahami ruang gerak perancangan.

| Batasan | Keterangan |
|---|---|
| Arsitektur microservices | Ditetapkan di awal sebagai tujuan pembelajaran |
| Pemisahan antrian tugas dan aliran peristiwa | Dua jenis perantara pesan wajib digunakan dengan peran yang berbeda dan dapat dipertanggungjawabkan |
| Penyimpanan dalam memori untuk cache, penguncian, dan penahanan sementara | Ditetapkan di awal |
| Basis data relasional, terpisah per layanan | Domainnya bersifat transaksional dan relasional |
| Satu bahasa untuk seluruh backend | Mengurangi beban pemeliharaan pada pengerjaan seorang diri |
| Antarmuka web dengan rendering sisi server | Halaman properti harus dapat diindeks mesin pencari |
| Tidak ada akses ke antarmuka supplier sungguhan | Seluruh supplier disimulasikan. Merupakan batasan sekaligus peluang, lihat Milestone 1 |

Pemilihan teknologi spesifik bukan bagian dari dokumen ini dan ditetapkan pada tahap perencanaan implementasi.

---

## 13. Asumsi dan Ketergantungan

### Asumsi

| ID | Asumsi | Dampak bila salah |
|---|---|---|
| A1 | Supplier tiruan dapat merepresentasikan karakteristik supplier sungguhan secara memadai | Klaim ketahanan menjadi lemah; perlu penambahan variasi kegagalan |
| A2 | Gerbang pembayaran dalam mode uji cukup untuk membuktikan alur saga | Perlu simulasi mandiri untuk skenario kegagalan tertentu |
| A3 | Ketersediaan tingkat gratis pada layanan hosting memadai untuk demonstrasi | Perlu anggaran, atau demonstrasi diganti rekaman video |
| A4 | Pengerjaan dilakukan seorang diri secara paruh waktu | Perkiraan waktu pada Bab 10 meleset |
| A5 | Penilai portofolio akan membaca README sebelum kode | Bukti perlu dipindahkan ke tempat yang lebih terlihat |

### Ketergantungan

| Ketergantungan | Sifat |
|---|---|
| Layanan gerbang pembayaran dalam mode uji | Eksternal, perlu pendaftaran akun |
| Layanan pengiriman surel dalam mode uji | Eksternal, dapat digantikan penangkap surel lokal |
| Penyedia hosting untuk demonstrasi | Eksternal |
| Data properti dan kota untuk mengisi supplier tiruan | Dapat dibangkitkan, tidak memblokir |

---

## 14. Keputusan Terbuka — SELURUHNYA TERJAWAB 2026-09-23

Seluruh tujuh pertanyaan sudah diputuskan. Bagian ini kini menjadi catatan keputusan, dan setiap butir wajib diangkat menjadi ADR pada Step 29.

- [x] **Q1 — Gerbang pembayaran: sandbox Midtrans.** Adapter Midtrans berada di belakang port `PaymentGateway`. Verifikasi tanda tangan SHA-512 dilakukan sungguhan. Konsekuensi yang harus ditangani: sandbox tidak dapat diperintah mengirim webhook gagal, terlambat, atau terbalik urutannya, sehingga skenario chaos yang menyangkut pembayaran menyuntikkan kegagalan di batas port, bukan di penyedia. Ini menjaga Step 28 tetap utuh tanpa membangun penyedia tiruan lengkap
- [x] **Q2 — Mata uang: dua, IDR dan USD.** Cukup membuktikan konversi dan pembulatan lintas mata uang. Sudah selaras dengan rancangan mock-supplier pada Step 04
- [x] **Q3 — Pembatalan: berjenjang dengan pengembalian sebagian.** Jenjang awal 100% sampai 7 hari sebelum tanggal masuk, 50% sampai 24 jam, 0% setelahnya. Perhitungan memakai `allocate` dari `packages/money` agar tidak ada satuan terkecil yang hilang
- [x] **Q4 — Rekonsiliasi: termasuk MVP.** Menjadi satu-satunya bukti langsung bahwa tidak ada pemesanan bayangan di sisi supplier. Milestone 6 bertambah sekitar 3 jam
- [x] **Q5 — TERJAWAB 2026-09-23.** Katalog internal untuk data **statis** saja: nama, alamat, koordinat, foto, fasilitas. Pemetaan ke pengenal supplier disimpan di tabel tersendiri. Harga dan ketersediaan **tidak pernah** masuk katalog — keduanya selalu bersumber dari supplier pada setiap pencarian, sehingga premis "inventaris bukan milik kita" tetap utuh. Konsekuensi: deduplikasi menjadi pencarian di tabel pemetaan alih-alih pencocokan kabur saat berjalan; URL properti stabil sehingga rendering sisi server dan ISR dapat berjalan sesuai Bab 12; autocomplete memakai full-text pada katalog. Properti yang dikembalikan supplier tetapi belum terpetakan tetap ditampilkan apa adanya tanpa URL stabil, dan masuk antrian pemetaan. Katalog dimiliki oleh search-service. Tercatat sebagai ADR pada Step 12b
- [x] **Q6 — Panel operator: aplikasi terpisah `apps/ops`.** Kode operator tidak pernah ikut terkirim ke bundel publik, dan aplikasinya dapat di-deploy tanpa akses publik. Berbagi `packages/ui` agar tampilan tetap konsisten
- [x] **Q7 — Demonstrasi: aktif selama masa melamar, video permanen.** Demo berjalan di tingkat gratis selama 3–6 bulan, video dua menit tertaut permanen di README sebagai cadangan. M12 terpenuhi pada periode yang paling menentukan

---

## 15. Risiko

| ID | Risiko | Kemungkinan | Dampak | Mitigasi |
|---|---|---|---|---|
| R1 | Perluasan lingkup ke moda transportasi lain | Tinggi | Tinggi | Bab 11 bersifat mengikat. Penambahan hanya setelah seluruh metrik Bab 7 terpenuhi |
| R2 | Supplier tiruan terlalu sederhana sehingga pembuktian ketahanan menjadi kosong | Sedang | Tinggi | Milestone 1 mensyaratkan variasi latensi, format, mata uang, dan mode kegagalan yang eksplisit |
| R3 | Cacat pada jalur kompensasi yang tidak terdeteksi karena diuji dengan tiruan | Sedang | Tinggi | NFR-19 mewajibkan pengujian dengan infrastruktur sungguhan |
| R4 | Pemakaian dua perantara pesan terkesan dipaksakan bagi penilai | Sedang | Sedang | Catatan keputusan arsitektur wajib memuat alasan pemisahan peran beserta alternatif yang ditolak |
| R5 | Kehilangan momentum pada pertengahan pengerjaan | Tinggi | Tinggi | Setiap milestone menghasilkan sesuatu yang dapat didemonstrasikan. Milestone 3 sudah menghasilkan produk yang terlihat utuh |
| R6 | Perkiraan waktu meleset jauh | Sedang | Sedang | Lingkup Should dan Could dapat dipangkas tanpa membatalkan hipotesis |
| R7 | Biaya hosting melebihi anggaran | Rendah | Sedang | Rencana cadangan berupa rekaman video demonstrasi |
| R8 | Terjebak memoles antarmuka alih-alih menyelesaikan sistem | Sedang | Sedang | Investasi tampilan dibatasi pada alur pencarian dan pemesanan saja |
| R9 | Kompleksitas domain OTA belum sepenuhnya dipahami sehingga model data berubah besar di tengah jalan | Sedang | Tinggi | Bab 8 disepakati dan dikunci sebelum Milestone 3 dimulai |

---

## 16. Definisi Selesai

MVP dinyatakan selesai ketika seluruh pernyataan berikut benar:

1. Seluruh kebutuhan berprioritas **Must** pada Bab 9.1 terpenuhi
2. Seluruh kebutuhan non-fungsional pada Bab 9.2 terpenuhi
3. Seluruh metrik pada Bab 7.1 dan 7.2 tercapai dan terdokumentasi dengan bukti
4. Seluruh kriteria penerimaan pada Bab 9.3 terverifikasi oleh uji otomatis
5. Seluruh pertanyaan terbuka pada Bab 14 telah terjawab dan keputusannya tercatat
6. Demonstrasi dapat diakses publik tanpa proses instalasi

---

*Status: DRAFT — dokumen kebutuhan. Perencanaan implementasi belum dilakukan.*
