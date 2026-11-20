# ADR-0005 — Rekonsiliasi dengan supplier

**Status:** Diterima · **Tanggal:** 2026-11-20 · **Menjawab:** Step 28, keputusan Q4

## Konteks

Q4 sudah dijawab di PRD: rekonsiliasi **termasuk MVP**. Ia satu-satunya bukti langsung bahwa tidak ada pemesanan bayangan di sisi supplier. FR-33 meminta ketidaksesuaian dicatat dan pemesanannya dipindahkan ke `NEEDS_REVIEW`, tanpa diperbaiki otomatis.

Saga, pemulih, dan penyapu menjamin setiap pemesanan berakhir di keadaan final. Mereka tidak menjamin keadaan final itu **benar** menurut supplier. Tiga kegagalan yang tidak terlihat saga:

- Supplier membatalkan pemesanan terkonfirmasi tanpa memberi tahu.
- Pemesanan dibuat di supplier untuk pemesanan yang sudah kita refund — misalnya perintah konfirmasi dari dead letter yang diputar ulang.
- Nilai atau tanggal di supplier berbeda dari yang kita catat.

Q4 menyisakan lima hal yang belum diputuskan.

## Keputusan

### 1. Tidak ada perbaikan otomatis

Satu-satunya akibat ketidaksesuaian adalah pemesanan berpindah ke `NEEDS_REVIEW` dengan alasannya, dan temuannya dicatat. Tidak ada refund, konfirmasi ulang, atau pembatalan di supplier.

Supplier yang sedang bermasalah dapat membuat ratusan pemesanan sah tampak "hilang" dalam satu putaran, misalnya basis data yang dipulihkan dari cadangan semalam. Perbaikan otomatis atas putaran itu berarti ratusan refund untuk kamar yang sebenarnya ada. Peninjauan yang berlebihan dapat dibereskan manusia, sedangkan uang yang sudah keluar tidak dapat ditarik kembali.

### 2. Rekonsiliasi boleh menyentuh keadaan final, hanya menuju keadaan final

Perintah domain baru `flagMismatch` dipasang pada CONFIRMED, REFUNDED, dan CANCELLED yang sudah dibayar, dengan tujuan `NEEDS_REVIEW`.

ADR-0004 menyatakan keadaan final tidak punya transisi keluar yang dijalankan sistem, kecuali permintaan pengguna. ADR ini menambah satu golongan lagi: **perintah rekonsiliasi**. Seperti perintah pengguna, perintah ini datang dari luar saga — tidak ada peristiwa, batas waktu, atau pemulihan yang menjalankannya. Bedanya, tujuannya selalu keadaan final. Pemesanan berpindah dari satu akhir yang sah menurut NFR-06 ke akhir sah lainnya, "ditandai untuk peninjauan manual", dan tidak pernah dibuka kembali untuk saga.

Uji finalitas dua arah di `transitions.test.ts` diperbarui. Uji itu kini menyatakan:

- Satu-satunya jalan keluar dari keadaan final adalah perintah dari luar saga.
- Setiap perintah rekonsiliasi berujung di keadaan final.
- `NEEDS_REVIEW` tetap tanpa jalan keluar.

CANCELLED yang tidak pernah dibayar ditolak domain (`mismatch_without_payment`). Pemesanan seperti itu tidak pernah dikirim ke supplier untuk dikonfirmasi, dan `NEEDS_REVIEW` menuntut pembayaran yang dapat diperiksa.

### 3. Yang diperiksa, dan dengan pegangan apa

| Keadaan kita            | Pegangan                                              | Tidak cocok bila                                                      |
| ----------------------- | ----------------------------------------------------- | --------------------------------------------------------------------- |
| CONFIRMED, belum keluar | booking reference                                     | tidak ada, dibatalkan, nilai berbeda dari harga hold, tanggal berbeda |
| REFUNDED                | idempotency key `book` (tidak pernah punya reference) | masih aktif di supplier                                               |
| CANCELLED yang dibayar  | booking reference                                     | masih aktif di supplier                                               |

Nilai dibandingkan dengan **harga bersih supplier saat hold**, yang kini dicatat di peristiwa `BookingHeld`, bukan dengan harga jual. Harga jual memuat markup yang dapat berubah sesudah pemesanan dibuat. Pemesanan sebelum Step 28 tidak punya catatan harga hold, jadi nilainya tidak dibandingkan, dan putusannya menyebut hal itu.

Supplier yang tidak dapat ditanya **bukan** ketidaksesuaian. Hasilnya dicatat `unverified`, tidak ditandai, dan diperiksa lagi pada putaran berikutnya. "Tidak ada di supplier" hanya dibaca dari 404 berkode `SUPPLIER_BOOKING_NOT_FOUND`. 404 lain — rute yang tidak ada di supplier-service versi lama — akan menandai setiap pemesanan terkonfirmasi sebagai hilang.

Keadaan tengah tidak diperiksa: putusan atas pemesanan yang sedang berpindah hanyalah putusan atas kebetulan waktu. Begitu juga perubahan yang lebih baru dari masa tenggang (10 menit), karena catatan supplier mungkin tertinggal.

### 4. Satu putaran per slot, berapa pun instance-nya

Penjadwal di setiap instance booking-service mengirim `reconciliation.run` dengan eventId yang **diturunkan** dari awal slot (UUID v8 dari SHA-256), setiap enam jam. Baris `reconciliation_runs` berkunci eventId itu (`INSERT ... ON CONFLICT DO NOTHING`), sehingga tiga instance menghasilkan satu putaran. Putaran yang mati di tengah dilanjutkan oleh pesan yang sama. Temuan unik per (putaran, pemesanan).

Alternatif yang ditolak:

- **Kunci penasihat di penjadwal.** Kunci ini mencegah pengiriman ganda, tetapi bukan pemrosesan ganda: RabbitMQ tetap mengirim ulang pesan yang ack-nya hilang.
- **Cron di luar service.** Menambah satu komponen lagi untuk dikerahkan dan dipantau.

Operator dapat meminta putaran sekarang dari panel. Permintaan itu lewat antrean yang sama, dengan eventId acak.

### 5. Batas ukuran putaran

Satu putaran berjalan di dalam satu pesan RabbitMQ yang di-ack setelah selesai. Konfigurasi menolak `RECONCILIATION_MAX_BOOKINGS × UPSTREAM_TIMEOUT_MS ≥ 25 menit`, karena `consumer_timeout` bawaan broker adalah 30 menit. Putaran yang lebih lama dari batas itu akan dikirim ulang tanpa akhir. Sisa kandidat diperiksa pada putaran berikutnya: setiap putaran memeriksa seluruh jendelanya, bukan selisih sejak putaran sebelumnya.

## Akibat

- Pemesanan bayangan untuk pemesanan yang kita kenal **terdeteksi**. Pemesanan di supplier yang tidak menyebut pemesanan kita sama sekali tidak terdeteksi: tidak ada adapter yang dapat mendaftar seluruh pemesanan supplier.
- Peninjau di panel operator melihat dua antrean yang saling melengkapi. Antrean tinjauan berisi pemesanan yang harus diputuskan, dan laporan rekonsiliasi berisi asal temuannya.
- notification-service **tidak** mengabarkan temuan rekonsiliasi kepada pengguna. Operator memeriksanya lebih dulu.
