# Step 05 — Package event-contracts dan messaging

**Fase 1** · Milestone 2 · Estimasi 5 jam · Prasyarat: Step 04

## Tujuan

Mengunci kontrak peristiwa antar service sebelum ada service yang menerbitkannya, dan membungkus dua perantara pesan dengan pemisahan peran yang tegas. Kontrak yang disepakati belakangan selalu berakhir sebagai objek longgar tanpa tipe.

## Prompt

```
Buat dua package: packages/event-contracts dan packages/messaging.

Baca docs/plan/CONVENTIONS.md dan PRD Bab 8 dan Bab 12 terlebih dahulu.

=== packages/event-contracts ===

Berisi skema Zod untuk seluruh peristiwa Kafka dan seluruh perintah RabbitMQ.
Ini satu-satunya sumber kebenaran bentuk pesan antar service.

Amplop baku untuk setiap peristiwa:
- eventId (UUID v7)
- eventType
- eventVersion (mulai dari 1)
- occurredAt (ISO 8601 UTC)
- correlationId
- causationId (eventId penyebab, boleh kosong)
- payload

Peristiwa Kafka yang didefinisikan (fakta yang sudah terjadi):
- search.performed
- booking.created
- booking.held
- booking.price_changed
- booking.confirmed
- booking.failed
- booking.cancelled
- payment.succeeded
- payment.failed
- payment.refunded
- supplier.degraded
- supplier.recovered

Perintah RabbitMQ yang didefinisikan (pekerjaan yang harus dikerjakan):
- supplier.confirm
- supplier.cancel
- voucher.generate
- notification.send
- payment.refund
- reconciliation.run

Ketentuan:
- Tipe diturunkan dengan z.infer, tidak ditulis dua kali
- Sediakan helper createEvent yang mengisi amplop otomatis dari context
  correlation, sehingga pemanggil hanya menyediakan payload
- Sediakan registry yang memetakan eventType ke skemanya, untuk validasi di consumer
- Tulis test yang memastikan setiap peristiwa punya skema terdaftar dan
  setiap skema dapat mem-parse contoh payload-nya

=== packages/messaging ===

Membungkus KafkaJS dan amqplib dengan pemisahan peran yang tegas.
Aturan yang ditegakkan di API-nya: Kafka untuk peristiwa, RabbitMQ untuk perintah.
Jangan menyediakan cara memublikasikan perintah ke Kafka atau peristiwa ke RabbitMQ.

Modul Kafka:
- createEventPublisher: menerbitkan peristiwa dengan validasi skema sebelum kirim,
  kunci partisi ditentukan pemanggil (umumnya bookingId agar urutan terjaga)
- createEventConsumer: berlangganan topik, memvalidasi pesan masuk terhadap
  registry, menolak pesan cacat ke dead letter topic, menjamin commit offset
  hanya setelah handler selesai
- Consumer harus menangani rebalance dan berhenti dengan benar saat shutdown

Modul RabbitMQ:
- createCommandSender: mengirim perintah ke queue, dengan validasi skema
- createCommandConsumer: mengonsumsi dengan ack manual, prefetch dapat dikonfigurasi
- Topologi retry berjenjang menggunakan DLX dan TTL:
  queue utama -> retry 5 detik -> retry 30 detik -> retry 2 menit -> dead letter
  Jumlah percobaan dibaca dari header x-death
- Sediakan helper untuk mendeklarasikan topologi ini secara idempoten saat startup

Modul bersama:
- Middleware consumer yang otomatis memulihkan correlationId dari amplop pesan
  ke AsyncLocalStorage, sehingga log di consumer tetap terkorelasi
- Penanganan error: error operasional memicu retry, error validasi langsung
  ke dead letter tanpa retry karena mencoba ulang pesan cacat tidak ada gunanya

Terakhir:
- Buat skrip infra/create-topics.ts yang membuat seluruh topik Kafka dengan
  jumlah partisi yang sesuai, dan perbarui infra/topics.md dengan daftar
  final beserta alasan jumlah partisinya
- Tambahkan skrip pnpm topics:create

Tulis test untuk: validasi menolak payload salah, retry berjenjang berpindah queue
dengan benar, pesan cacat masuk dead letter tanpa retry, dan correlationId pulih
di sisi consumer.

Setelah selesai, commit: feat: add event contracts and messaging packages
```

## Definisi Selesai

- [ ] Seluruh peristiwa dan perintah punya skema Zod dan terdaftar di registry
- [ ] API package secara struktural tidak memungkinkan mengirim perintah lewat Kafka atau peristiwa lewat RabbitMQ
- [ ] Topologi retry berjenjang terbentuk otomatis dan terbukti berpindah queue sesuai jumlah percobaan
- [ ] Pesan cacat masuk dead letter tanpa retry
- [ ] `correlationId` pulih otomatis di consumer — dibuktikan dengan test
- [ ] Commit offset hanya terjadi setelah handler selesai — dibuktikan dengan test
- [ ] `pnpm topics:create` membuat seluruh topik dan dapat dijalankan berulang tanpa galat — **belum diverifikasi terhadap broker sungguhan**, lihat Catatan
- [ ] Commit terbuat

## Catatan

Pemisahan peran yang ditegakkan lewat API adalah jawaban untuk risiko R4 di PRD. Ketika penilai bertanya "kenapa dua broker", kode ini sendiri yang menjelaskannya — bukan paragraf di README.

### Temuan saat mengerjakan step ini

**1. Header `x-death` milik RabbitMQ tidak dapat dipakai menghitung percobaan.** Nilainya dihitung **per antrian**, sehingga pesan yang melewati tiga antrian tunda berbeda punya tiga hitungan terpisah dan tidak satu pun mewakili jumlah percobaan sebenarnya. Hitungan disimpan di header kita sendiri, `x-tbe-retry-count`.

**2. Pesan cacat di Kafka tidak boleh dilempar dari consumer.** Melempar berarti offset tidak ter-commit dan partisi berhenti **selamanya** pada pesan yang tidak akan pernah bisa diproses — seluruh pemesanan di partisi itu ikut berhenti. Pesan cacat dikirim ke dead letter lalu dianggap selesai. Kegagalan pemrosesan yang sebenarnya tetap dilempar.

**3. Kunci partisi yang hilang adalah kegagalan senyap.** Kafka akan menyebar pesan round-robin tanpa satu pun galat, dan urutan per pemesanan hilang. Karena itu kunci yang hilang dilaporkan sebagai galat saat menerbitkan, bukan dibiarkan menjadi `null`.

**4. Header RabbitMQ tiba sebagai string, angka, atau Buffer** tergantung klien penerbitnya. Ketiganya harus dinormalkan; `String(value)` atas Buffer atau objek menghasilkan nilai yang menyesatkan.

**5. Topologi dideklarasikan sebagai data, bukan sebagai rangkaian `assertQueue`.** Dengan begitu ia dapat diperiksa pengujian tanpa broker yang berjalan. Topologi yang hanya ada sebagai efek samping pemanggilan hanya bisa diperiksa dengan membuka antarmuka RabbitMQ dan melihatnya dengan mata.

### Yang belum diverifikasi

Docker Desktop tidak berjalan saat step ini dikerjakan, sehingga **`pnpm topics:create` belum pernah dijalankan terhadap Kafka sungguhan**. Yang sudah terbukti: skripnya ter-build, dapat dimuat, dan mencoba menyambung ke broker. Yang belum: pembuatan topik yang sebenarnya, dan sifat idempotennya pada pemanggilan kedua.

Jalankan ini setelah Docker menyala, sebelum memulai Step 06:

```bash
pnpm infra:up && pnpm topics:create && pnpm topics:create
```

Pemanggilan kedua harus melaporkan "Seluruh topik sudah ada."
