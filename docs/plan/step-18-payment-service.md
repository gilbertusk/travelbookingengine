# Step 18 — payment-service

**Fase 3** · Milestone 4 · Estimasi 6 jam · Prasyarat: Step 17 · Q1 sudah dijawab: sandbox Midtrans

## Tujuan

Menangani uang masuk dan keluar dengan jaminan idempotency. Webhook pembayaran datang berulang sebagai perilaku normal, bukan anomali, dan sistem harus tahan terhadap itu.

## Prompt

```
Buat apps/payment-service.

Baca terlebih dahulu PRD FR-19 sampai FR-23, NFR-07, dan CONVENTIONS.md bagian 9.

Tulis test lebih dulu.

Keputusan Q1 sudah diambil: memakai sandbox Midtrans.

Seluruh komunikasi ke Midtrans berada di belakang port PaymentGateway. Port ini
bukan formalitas — ia adalah titik tempat chaos test Step 28 menyuntikkan
kegagalan, karena sandbox tidak dapat diperintah gagal sesuai kehendak.
Jangan memanggil SDK Midtrans dari mana pun selain adapter-nya.

Ketentuan khusus Midtrans:
- Verifikasi tanda tangan notifikasi memakai SHA-512 atas
  order_id + status_code + gross_amount + server_key. Lakukan dengan
  perbandingan waktu tetap, bukan perbandingan string biasa
- Server key dan client key dari env, divalidasi saat startup
- Pemetaan status Midtrans ke status internal dinyatakan eksplisit sebagai
  tabel, bukan rangkaian percabangan: capture dan settlement menjadi SUCCEEDED,
  pending tetap PENDING, deny, cancel, expire, dan failure menjadi FAILED
- transaction_id dari Midtrans dipakai sebagai pengenal peristiwa untuk
  idempotency
- Sandbox mengirim notifikasi ganda sebagai perilaku normal. Ini bukan anomali
  yang perlu dicegah, melainkan yang harus ditangani

1. Domain
   - Payment dengan keadaan: PENDING, SUCCEEDED, FAILED, REFUNDED,
     PARTIALLY_REFUNDED
   - Refund sebagai entitas tersendiri, satu pembayaran bisa punya beberapa refund
   - Seluruh nilai memakai packages/money
   - Total refund tidak boleh melebihi nilai pembayaran. Tegakkan di domain,
     bukan hanya di database

2. Idempotency webhook (NFR-07)
   Ini inti step ini:
   - Setiap webhook masuk disimpan dengan pengenal peristiwa dari penyedia
     sebagai kunci unik
   - Webhook yang sudah pernah diproses mengembalikan hasil sebelumnya tanpa
     efek samping apa pun
   - Ditegakkan lewat batasan unik database, bukan pemeriksaan di aplikasi
   - Webhook yang datang tidak berurutan ditangani benar: notifikasi sukses
     yang tiba setelah notifikasi gagal tidak boleh membalikkan keadaan final
   - Tanda tangan webhook diverifikasi sebelum diproses. Tanda tangan tidak sah
     ditolak dan dicatat sebagai peringatan keamanan

3. Alur pembayaran
   - Buat maksud pembayaran untuk satu pemesanan, dengan nilai yang diambil
     dari harga yang disetujui pengguna
   - Terima notifikasi penyedia
   - Terbitkan payment.succeeded atau payment.failed ke Kafka
   - Jangan memanggil booking-service secara langsung. Komunikasi lewat peristiwa

4. Refund
   - Consumer RabbitMQ untuk perintah payment.refund
   - Refund bersifat idempoten terhadap pengenal permintaan refund
   - Refund gagal masuk retry berjenjang, dan setelah habis masuk dead letter
     dengan peringatan tingkat error, karena ini berarti uang pengguna tertahan
   - Terbitkan payment.refunded setelah berhasil

5. Skema Prisma
   - payments: id, bookingId, amount (integer), currency, status, gatewayRef,
     idempotencyKey unik, createdAt, updatedAt
   - refunds: id, paymentId, amount, currency, reason, status, gatewayRef,
     requestId unik, createdAt
   - webhook_events: id, providerEventId unik, payload, processedAt, outcome
   - Tidak ada kolom float atau double

6. Keamanan
   - Kredensial penyedia dari env, divalidasi saat startup
   - Payload webhook yang dicatat sudah diredaksi dari data sensitif
   - Endpoint webhook tidak memerlukan autentikasi pengguna tetapi memverifikasi
     tanda tangan, dan punya pembatasan laju tersendiri

Test yang wajib:
- Webhook sama diproses dua kali hanya menghasilkan satu efek
- Sepuluh webhook identik serentak hanya menghasilkan satu efek
- Webhook tidak berurutan tidak membalikkan keadaan final
- Tanda tangan tidak sah ditolak
- Refund melebihi nilai pembayaran ditolak di domain
- Refund idempoten terhadap pengenal permintaan

Commit: feat: add payment service with idempotent webhook handling
```

## Definisi Selesai

- [ ] Idempotency webhook ditegakkan lewat batasan unik database
- [ ] Sepuluh webhook identik serentak menghasilkan tepat satu efek
- [ ] Webhook tidak berurutan tidak merusak keadaan final
- [ ] Tanda tangan diverifikasi dan yang tidak sah dicatat sebagai peringatan keamanan
- [ ] Total refund tidak dapat melebihi nilai pembayaran
- [ ] Refund gagal permanen mencatat galat tingkat error, bukan sekadar peringatan
- [ ] Tidak ada kredensial di kode atau test
- [ ] Cakupan test ≥ 85%
- [ ] Commit terbuat

## Catatan

Test "sepuluh webhook identik serentak" berbeda dari "webhook diproses dua kali berurutan". Yang pertama menguji balapan di database, yang kedua hanya menguji percabangan. Pastikan yang pertama ada — itu yang membuktikan idempotency sungguhan.
