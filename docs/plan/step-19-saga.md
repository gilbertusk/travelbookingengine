# Step 19 — Saga dan kompensasi

**Fase 3** · Milestone 4 · Estimasi 8 jam · Prasyarat: Step 18

## Tujuan

Step paling bernilai di seluruh project. Menjamin bahwa setiap alur pemesanan berakhir di keadaan final, dan tidak ada pengguna yang kehilangan uang. Ini memenuhi G3, NFR-06, dan US-03.

## Prompt

```
Implementasikan orkestrasi saga pemesanan di apps/booking-service.

Baca terlebih dahulu:
- PRD Bab 2.2 masalah 3, G3, NFR-06, NFR-07, NFR-10, US-03, US-05
- Step 16 state machine yang sudah dibuat
- docs/plan/CONVENTIONS.md

Tulis test lebih dulu. Setiap jalur kompensasi wajib punya test.

1. Orkestrator saga
   - Pola orkestrasi, bukan koreografi. booking-service yang memegang kendali
   - Definisikan setiap langkah sebagai data: nama, aksi, aksi kompensasi,
     dan apakah boleh dicoba ulang
   - Langkah alur bahagia:
     1. priceCheck
     2. holdLocal
     3. holdSupplier
     4. awaitPayment
     5. confirmSupplier
     6. issueVoucher
   - Setiap langkah punya kompensasi:
     holdLocal      -> lepaskan kunci Redis
     holdSupplier   -> batalkan hold di supplier
     awaitPayment   -> refund
     confirmSupplier-> batalkan pemesanan di supplier lalu refund

2. Persistensi keadaan saga
   - Tabel saga_states: id, bookingId, currentStep, stepStatus,
     compensationStatus, attempts, lastError, updatedAt
   - Keadaan saga disimpan SEBELUM langkah dijalankan, bukan sesudah.
     Proses yang mati di tengah harus dapat dipulihkan
   - Saat startup, pulihkan saga yang tertinggal di keadaan tidak final

3. Pola outbox
   - Peristiwa Kafka tidak diterbitkan langsung di dalam transaksi bisnis
   - Simpan ke tabel outbox dalam transaksi yang sama dengan perubahan keadaan
   - Penerbit terpisah membaca outbox dan menerbitkan ke Kafka
   - Ini yang mencegah keadaan berubah tanpa peristiwa terbit, atau sebaliknya
   - Penerbit menjamin pengiriman minimal sekali; consumer harus idempoten

4. Alur kompensasi (US-03)
   - payment.succeeded memicu perintah supplier.confirm lewat RabbitMQ
   - Kegagalan yang boleh dicoba ulang mengikuti retry berjenjang dari Step 05
   - Kegagalan permanen setelah retry habis:
     terbitkan booking.failed, jalankan kompensasi berurutan mundur,
     kirim perintah payment.refund, lepaskan hold, pindahkan ke FAILED
     lalu REFUNDED setelah refund berhasil
   - Kegagalan kompensasi TIDAK boleh diabaikan. Setelah retry habis,
     pindahkan ke NEEDS_REVIEW dan catat galat tingkat error

5. Penanganan ketidakpastian (US-05)
   - Timeout pada confirmSupplier tidak boleh langsung dianggap gagal
   - Gunakan mekanisme dari Step 11: pastikan status sebenarnya lewat getBooking
   - Bila status tetap tidak dapat dipastikan setelah beberapa percobaan,
     pindahkan ke NEEDS_REVIEW, JANGAN refund secara membabi buta —
     refund untuk pemesanan yang sebenarnya berhasil menciptakan kerugian
     jenis lain

6. Jaminan yang harus dipenuhi
   - Setiap saga berakhir di keadaan final dalam waktu terbatas
   - Tidak ada pembayaran berhasil tanpa pemesanan terkonfirmasi atau refund
   - Tidak ada pemesanan terkonfirmasi tanpa pembayaran berhasil
   - Seluruh perubahan tercatat di booking_events untuk audit (NFR-10)

7. Antarmuka status
   - GET /bookings/:id/status
   - Endpoint SSE yang memancarkan perubahan status secara langsung,
     untuk dipakai di Step 21

Test yang wajib, masing-masing dengan skenario kegagalan disuntikkan:
- Alur bahagia mencapai CONFIRMED
- Supplier gagal permanen setelah pembayaran: mencapai REFUNDED, hold terlepas
- Pembayaran gagal setelah hold: hold terlepas, mencapai CANCELLED
- Timeout pada konfirmasi: getBooking dipanggil, bukan konfirmasi ulang
- Status tidak dapat dipastikan: mencapai NEEDS_REVIEW tanpa refund
- Kompensasi gagal: mencapai NEEDS_REVIEW dengan galat tingkat error
- Proses dimatikan di tengah saga lalu dihidupkan: saga dipulihkan dan selesai
- Outbox: perubahan keadaan dan penerbitan peristiwa selalu konsisten
- Peristiwa yang sama dikonsumsi dua kali tidak menghasilkan efek ganda

Jalankan /code-review setelah selesai. Ini kode paling kritis di project,
perbaiki seluruh temuan CRITICAL dan HIGH.

Commit: feat: add booking saga with compensation
```

## Definisi Selesai

- [ ] Setiap langkah punya kompensasi yang terdefinisi sebagai data
- [ ] Keadaan saga disimpan sebelum langkah dijalankan
- [ ] Saga yang tertinggal dipulihkan saat startup — dibuktikan dengan test mematikan proses di tengah
- [ ] Pola outbox menjamin konsistensi perubahan keadaan dan penerbitan peristiwa
- [ ] Kegagalan supplier setelah pembayaran menghasilkan refund otomatis
- [ ] Ketidakpastian status menghasilkan `NEEDS_REVIEW`, bukan refund membabi buta
- [ ] Kegagalan kompensasi menghasilkan `NEEDS_REVIEW` dan galat tingkat error
- [ ] Peristiwa yang dikonsumsi dua kali tidak menghasilkan efek ganda
- [ ] Endpoint SSE memancarkan perubahan status
- [ ] Cakupan jalur kompensasi 100%
- [ ] `/code-review` dijalankan dan temuan CRITICAL serta HIGH ditutup
- [ ] Commit terbuat

## Catatan

Keputusan untuk tidak melakukan refund saat status tidak dapat dipastikan adalah bagian paling menarik dari step ini. Refund otomatis terdengar lebih ramah, tetapi bila pemesanan sebenarnya berhasil, platform menanggung biaya kamar yang tetap terpakai. Catat pertimbangan ini sebagai ADR — pertanyaan seperti ini yang membedakan engineer yang memikirkan konsekuensi bisnis.
