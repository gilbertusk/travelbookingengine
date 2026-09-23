# Step 03 — Package shared-kernel

**Fase 0** · Milestone 1 · Estimasi 5 jam · Prasyarat: Step 02

## Tujuan

Menulis sekali hal-hal yang dibutuhkan sepuluh service: konfigurasi, log, error, bootstrap server, dan graceful shutdown. Tanpa ini, tiap service akan menuliskannya ulang dengan cara yang sedikit berbeda, dan keseragaman repo hilang.

## Prompt

```
Buat packages/shared-kernel, fondasi bersama untuk seluruh service backend.

Baca docs/plan/CONVENTIONS.md terlebih dahulu dan patuhi seluruh aturannya,
terutama bagian penanganan error, log, dan konfigurasi.

Tulis test lebih dulu untuk setiap modul yang punya logika.

Modul yang dibuat:

1. config
   - Fungsi createConfig yang menerima skema Zod dan mem-parse process.env
   - Gagal validasi berarti proses berhenti dengan pesan yang menyebutkan
     variabel mana yang salah dan apa yang diharapkan
   - Sediakan skema dasar bersama: NODE_ENV, PORT, LOG_LEVEL, SERVICE_NAME

2. logger
   - Berbasis Pino, keluaran JSON
   - Otomatis menyertakan serviceName dan correlationId dari context
   - Redaksi otomatis untuk field sensitif: password, token, authorization,
     apiKey, credentials, cardNumber
   - Mode pengembangan memakai pino-pretty

3. correlation
   - AsyncLocalStorage untuk menyimpan correlationId sepanjang satu alur
   - Middleware HTTP yang membaca header x-correlation-id atau membuat UUID v7 baru
   - Helper untuk mengambil correlationId dari mana saja tanpa meneruskan argumen

4. errors
   - Kelas dasar AppError dengan properti: code, httpStatus, isOperational, details
   - Turunan: ValidationError, NotFoundError, ConflictError, UnauthorizedError,
     ForbiddenError, UpstreamError, TimeoutError
   - UpstreamError membawa informasi supplier mana yang gagal
   - Fungsi toErrorResponse yang mengubah error jadi bentuk respons aman,
     tanpa membocorkan detail internal

5. http
   - createHttpServer: pabrik Express dengan urutan middleware baku —
     correlation, logger request, helmet, cors, parser JSON dengan batas ukuran
   - Middleware error handler yang berada paling akhir, memetakan AppError ke
     status dan bentuk respons konsisten, dan mencatat error tak terduga
   - Helper validate(schema, source) untuk memvalidasi body, query, atau params
   - Bentuk respons baku: { data, error, meta } sesuai pola envelope

6. lifecycle
   - createApp yang menerima daftar sumber daya (server, koneksi db, consumer,
     koneksi broker) dan menangani startup berurutan
   - Graceful shutdown pada SIGTERM dan SIGINT: berhenti menerima permintaan baru,
     selesaikan yang sedang berjalan, tutup consumer setelah commit offset,
     tutup koneksi, dengan batas waktu paksa
   - Ini penting: consumer Kafka yang mati tanpa commit offset menyebabkan
     pemrosesan ganda

7. health
   - Endpoint /health/live dan /health/ready
   - Ready memeriksa seluruh dependensi yang didaftarkan

8. result
   - Tipe Result<T, E> beserta helper ok, err, isOk, isErr, map, mapErr
   - Dipakai untuk error yang dapat diantisipasi, sesuai CONVENTIONS.md bagian 5

Ketentuan:
- Package ini tidak boleh bergantung pada Kafka, RabbitMQ, Redis, atau Prisma
- Seluruh modul diekspor lewat entry point yang jelas
- Cakupan test minimal 90% untuk package ini, karena seluruh service bergantung padanya

Setelah selesai jalankan test dan lint, lalu commit:
feat: add shared-kernel package
```

## Definisi Selesai

- [ ] Seluruh modul punya test dan cakupan ≥ 90%
- [ ] Env tidak valid membuat proses berhenti dengan pesan yang jelas — buktikan dengan test
- [ ] `correlationId` mengalir otomatis ke seluruh log dalam satu permintaan — buktikan dengan test
- [ ] Field sensitif teredaksi di log — buktikan dengan test
- [ ] Graceful shutdown menutup sumber daya dengan urutan benar — buktikan dengan test
- [ ] Package tidak bergantung pada pustaka infrastruktur apa pun
- [ ] Commit terbuat

## Catatan

Graceful shutdown terlihat sepele sampai Step 19. Saga yang terpotong di tengah karena container dimatikan tanpa urutan yang benar menghasilkan pemesanan menggantung — persis yang dilarang NFR-06.
