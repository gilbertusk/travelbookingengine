# Step 22 — Uji beban konkurensi

**Fase 3** · Milestone 4 · Estimasi 4 jam · Prasyarat: Step 21

## Tujuan

Membuktikan M5 dan M6: nol pemesanan ganda, dan nol uang tertahan. Ini angka yang paling sering dikutip saat orang membaca README project semacam ini.

## Prompt

```
Buat rangkaian uji beban konkurensi untuk alur pemesanan dan buktikan
metrik M5 dan M6 pada PRD.

Baca terlebih dahulu PRD Bab 7.1, US-04, dan US-05.

1. Skenario k6 di infra/k6/
   - booking-contention.js
     1000 pengguna virtual mencoba memesan rate plan yang sama secara serentak,
     dengan ketersediaan hanya 10. Ini implementasi langsung US-04
   - booking-supplier-failure.js
     Beban pemesanan normal, lalu supplier dimatikan di tengah lewat panel
     kendali mock-supplier. Mengukur berapa banyak yang mencapai keadaan final
     dan berapa yang direfund
   - booking-idempotency.js
     Permintaan berulang dengan idempotency key sama, dikirim serentak

2. Verifikasi setelah uji
   Skrip verifikasi yang dijalankan setelah setiap skenario dan memeriksa
   langsung ke database serta Redis:
   - Jumlah pemesanan CONFIRMED tepat sama dengan ketersediaan awal
   - Tidak ada booking reference supplier yang muncul lebih dari sekali
   - Setiap pembayaran berhasil punya pemesanan terkonfirmasi atau refund
   - Tidak ada pemesanan tertinggal di keadaan tidak final
   - Tidak ada kunci hold yatim di Redis
   - Jumlah pemesanan di mock-supplier sama dengan jumlah CONFIRMED di sistem kita

   Skrip ini gagal bila satu invarian saja dilanggar.

3. Pengukuran tambahan
   - Latensi p95 alur hold
   - Waktu dari pembayaran sampai konfirmasi
   - Waktu dari kegagalan sampai refund selesai
   - Jumlah pemesanan yang berakhir di NEEDS_REVIEW, beserta sebabnya

4. Bukti
   - Buat docs/evidence/booking-concurrency.md berisi: konfigurasi uji,
     hasil tiap skenario, keluaran skrip verifikasi, dan tangkapan layar Grafana
   - Sertakan juga trace Jaeger dari satu alur kompensasi lengkap.
     Gambar ini menjelaskan arsitektur lebih baik daripada diagram mana pun

5. Bila ada invarian yang dilanggar
   Jangan melanjutkan ke step berikutnya. Selidiki dengan urutan:
   - Periksa apakah pengurangan ketersediaan benar-benar atomik
   - Periksa apakah ada jalur yang melewati skrip Lua
   - Periksa apakah batasan unik idempotency benar-benar ada di database
   - Periksa trace untuk alur yang menghasilkan pelanggaran
   Catat temuan dan perbaikannya — ini bahan bagus untuk bagian
   "cerita kegagalan" di README nanti

Commit: test: add booking concurrency load tests and evidence
```

## Definisi Selesai

`[x]` terbukti, `[~]` terbukti sebagian (sebabnya ditulis), `[ ]` belum.

- [x] M5 tercapai: 1000 permintaan serentak untuk ketersediaan 10 menghasilkan tepat 10 CONFIRMED — tiga jalan terakhir berturut-turut, terhadap Postgres, Redis, Kafka, dan RabbitMQ sungguhan; satu instance booking-service
- [x] Tidak ada booking reference supplier yang ganda — nol pada keempat skenario
- [~] M6 tercapai: setiap pembayaran berhasil berakhir terkonfirmasi atau direfund — terpenuhi ketat pada tiga skenario (60 pembayaran = 36 terkonfirmasi + 24 direfund pada skenario penolakan). Pada skenario supplier mati, 19 dari 59 pembayaran berakhir di `NEEDS_REVIEW`: tidak terkonfirmasi dan tidak direfund, melainkan diserahkan ke manusia. Disengaja (US-05), tetapi bukan yang dikatakan kalimat ini
- [~] Tidak ada pemesanan tertinggal di keadaan tidak final — nol pemesanan berhenti sambil memegang kamar atau uang (HELD, PAID, FAILED). Tetapi `DRAFT` dan `PRICE_CHECKED` yang ditinggalkan tidak pernah berakhir: 990 dan 61 pada jalan terakhir. Secara harfiah kotak ini TIDAK terpenuhi
- [x] Tidak ada kunci hold yatim di Redis — nol, di Redis maupun di supplier
- [x] Jumlah pemesanan di mock-supplier cocok dengan jumlah CONFIRMED — dan pemesanannya sama satu per satu, bukan hanya jumlahnya
- [~] Skrip verifikasi gagal otomatis bila satu invarian dilanggar — terbukti untuk pemeriksaan M5, yang lima kali menggagalkan jalan sungguhan (0, 1, dan 9 CONFIRMED). Enam pemeriksaan lain belum pernah terlihat gagal di pelari beban
- [x] `docs/evidence/booking-concurrency.md` berisi hasil, tangkapan Grafana, dan trace Jaeger — dua panel Grafana kosong dan dibiarkan terlihat
- [x] Commit terbuat

## Temuan

Rinciannya, beserta seluruh angkanya, ada di [docs/evidence/booking-concurrency.md](../evidence/booking-concurrency.md). Yang dicatat di sini adalah yang mengubah kode atau cara kerja.

### Uji beban menemukan cacat yang tidak terlihat 691 uji unit yang hijau

Permintaan price check kembar — kunci idempotensi yang sama — menjalankan price check ulang, dan price check ulang menaikkan versi pemesanan walau harganya tidak berubah. Hold yang sedang menunggu supplier lalu kalah kunci versi pada commit terakhirnya, dibatalkan, dan dikompensasi. Pemanggilnya dijawab "sedang diproses" padahal tidak ada lagi yang memprosesnya. Sembilan dari sepuluh kunci pada jalan pertama skenario idempotensi berakhir tanpa hold.

Perbaikannya di `place-hold.ts`: commit HELD yang kalah dibaca ulang dan diulang, paling banyak tiga kali. Yang dimaafkan hanya versi yang bergeser. Harga yang berubah, pemesanan yang tidak lagi menunggu hold, dan saga yang sudah diambil alih pemulih tetap membatalkan — dan ketiga penjaga itu masing-masing terbukti menggagalkan uji saat sengaja dirusak:

| Suntikan                                   | Akibat      |
| ------------------------------------------ | ----------- |
| harga tidak diperiksa saat baca ulang      | 1 uji gagal |
| kepemilikan saga tidak diperiksa           | 1 uji gagal |
| batas baca ulang dilonggarkan dari 3 ke 50 | 1 uji gagal |

### Tiga skenario yang lulus tanpa menguji apa pun

Tiga kali di step ini sebuah skenario hijau untuk alasan yang salah, dan ketiganya baru terlihat setelah angkanya dibaca, bukan statusnya:

- Skenario supplier mati lulus dengan nol refund dan nol peninjauan: alurnya selesai dalam satu detik, jadi tidak ada pemesanan yang sedang berada di antara hold dan konfirmasi saat supplier mati.
- Pemeriksaan "tidak ada pemesanan di keadaan tidak final" lulus dengan 990 `PRICE_CHECKED` di tabel, karena yang diperiksanya hanya HELD, PAID, dan FAILED.
- "Gagal → refund 117 ms" benar, dan menyesatkan: ia mengukur sejak saga menyatakan gagal. Dari sudut pengguna penantiannya 155 detik, karena perintah konfirmasi dicoba sepanjang jenjang retry lebih dulu.

Yang pertama diperbaiki dengan jeda membayar 0–20 detik; yang kedua dengan nama yang menyebut apa yang diperiksa dan jumlah pra-hold yang ikut dilaporkan; yang ketiga dengan ukuran kedua, bayar → refund.

### Skenario keempat yang tidak ada di prompt

Prompt meminta tiga skenario. Skenario supplier mati — koneksi diterima lalu diputus — menurut rancangan Step 20 berakhir di peninjauan manusia, tidak pernah di refund. Akibatnya "berapa yang direfund" dan "waktu dari kegagalan sampai refund" tidak dapat dijawab olehnya.

`booking-supplier-refusal` ditambahkan: beban yang sama, tetapi supplier menjawab 503, yang merupakan kepastian bahwa permintaannya tidak dikerjakan. Kontainernya tidak dihentikan, jadi buku pemesanan supplier tiruan tetap utuh dan pemeriksaan "cocok dengan CONFIRMED" tetap berarti. Dari skenario inilah trace kompensasi di berkas bukti berasal.

### Tiga dugaan yang gugur

Proses Node mati dengan kode `0xC0000409` tanpa pesan, lima kali dalam dua hari. Tiga penjelasan diajukan dan ketiganya gugur oleh pengukuran, bukan oleh perdebatan:

- **Kehabisan memori** — sisa commit direkam tiap lima detik. Crash terjadi dengan 1,3 GB tersisa; jalan lain lulus dengan 349 MB.
- **Galat fatal V8** — `--report-on-fatalerror` aktif pada setiap jalan sesudahnya, dan tidak pernah menghasilkan laporan.
- **Jalur kode yang banyak melempar galat**, lalu perlindungan shadow stack — dua kematian terjadi satu detik setelah service siap, tanpa beban; shadow stack mati, dan prosesornya tidak mendukung.

Penyebabnya tetap tidak diketahui. Yang berubah: pelari uji sekarang gagal seketika dengan nama service dan kode keluarnya, alih-alih menunggu lima belas menit lalu melaporkan "tidak pernah tuntas" — yang terbaca seperti saga tersangkut.

### Utang

- Latensi hold p95 lima sampai delapan detik saat seribu hold tiba dalam satu detik. Penolakan "habis" membayar dua transaksi basis data lebih dulu.
- Pemesanan `DRAFT` dan `PRICE_CHECKED` yang ditinggalkan tidak pernah dibersihkan.
- Panel Grafana "Hasil langkah saga pemesanan" kosong: metriknya tidak pernah diekspor.
- Uji beban belum pernah dijalankan di Linux, dan belum dengan lebih dari satu instance booking-service.

## Catatan

Pemeriksaan "jumlah pemesanan di mock-supplier cocok dengan jumlah CONFIRMED" adalah yang paling jarang dilakukan orang, dan yang paling meyakinkan. Ia membuktikan tidak ada pemesanan bayangan di sisi supplier yang tidak tercatat di sistem kita.
