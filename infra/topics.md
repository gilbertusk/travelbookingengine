# Topik Kafka

Definisi topik tinggal sebagai kode di [`packages/event-contracts/src/topics.ts`](../packages/event-contracts/src/topics.ts). Dokumen ini menjelaskan **alasan** di balik angka-angkanya; kalau keduanya berbeda, kodenya yang benar dan dokumen ini yang perlu diperbarui.

Topik dibuat lewat skrip, bukan otomatis oleh broker:

```bash
pnpm topics:create
```

## Kenapa pembuatan otomatis dimatikan

Dengan pembuatan otomatis, salah ketik nama topik pada producer tidak menghasilkan galat apa pun. Kafka membuat topik baru bernama salah, pesan masuk ke sana, dan tidak ada consumer yang membacanya. Kegagalan seperti ini tidak bersuara dan biasanya baru ketahuan ketika data yang dinanti tidak pernah tiba — sering kali berhari-hari kemudian.

## Yang menentukan jumlah partisi

Dua hal, dan keduanya dijawab per topik di bawah:

1. **Kunci partisi menentukan urutan.** Kafka hanya menjamin urutan di dalam satu partisi. Seluruh peristiwa satu pemesanan harus berkunci `bookingId` — tanpa itu, `booking.confirmed` bisa tiba sebelum `booking.created` dan saga membaca keadaan yang belum ada.
2. **Jumlah partisi membatasi paralelisme.** Consumer aktif dalam satu group tidak pernah melebihi jumlah partisi. Terlalu sedikit membatasi throughput; terlalu banyak menambah beban tanpa manfaat pada skala ini.

## Daftar topik

| Topik                     | Partisi | Kunci partisi | Retensi | Peristiwa                                                                                                              |
| ------------------------- | ------- | ------------- | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| `tbe.booking.v1`          | 6       | `bookingId`   | 90 hari | `booking.created`, `booking.held`, `booking.price_changed`, `booking.confirmed`, `booking.failed`, `booking.cancelled` |
| `tbe.payment.v1`          | 6       | `bookingId`   | 90 hari | `payment.succeeded`, `payment.failed`, `payment.refunded`                                                              |
| `tbe.supplier-booking.v1` | 6       | `bookingId`   | 90 hari | `supplier.booking_confirmed`, `supplier.booking_rejected`, `supplier.booking_uncertain` (Step 19)                      |
| `tbe.search.v1`           | 3       | `city`        | 7 hari  | `search.performed`                                                                                                     |
| `tbe.supplier.v1`         | 1       | `supplier`    | 7 hari  | `supplier.degraded`, `supplier.recovered`                                                                              |
| `tbe.dead-letter.v1`      | 3       | topik asal    | 30 hari | pesan cacat dari topik mana pun                                                                                        |

## Alasan per topik

**`tbe.booking.v1` — 6 partisi, kunci `bookingId`, retensi 90 hari.**
Urutan per pemesanan wajib terjaga. Enam partisi memberi ruang enam consumer paralel untuk saga, yang memadai pada beban yang diuji di Step 22. Retensi panjang karena Step 27 harus dapat membangun ulang seluruh agregat dari awal topik.

**`tbe.payment.v1` — 6 partisi, kunci `bookingId`, retensi 90 hari.**
Dikunci `bookingId`, bukan `paymentId`, agar seluruh peristiwa pembayaran satu pemesanan tiba berurutan pada consumer yang sama dengan yang menangani pemesanannya. Retensi panjang untuk audit finansial.

**`tbe.supplier-booking.v1` — 6 partisi, kunci `bookingId`, retensi 90 hari.**
Ditambahkan Step 19. Perintah `supplier.confirm` berjalan lewat RabbitMQ, dan RabbitMQ tidak punya jalan balik: consumer-nya mengerjakan, mencoba ulang, lalu diam. Topik ini adalah jalan baliknya — fakta tentang pemesanan di supplier, dibaca saga di booking-service. Dikunci `bookingId`, bukan kode supplier, karena urutan yang penting adalah urutan per pemesanan. Terpisah dari `tbe.supplier.v1` karena yang itu satu partisi dan beretensi pendek, sementara jawaban supplier atas pemesanan yang sudah dibayar adalah catatan finansial.

**`tbe.search.v1` — 3 partisi, kunci `city`, retensi 7 hari.**
Hanya dibaca analitik dan urutan antar pencarian tidak penting. Dikunci kota agar agregasi per kota terkumpul di satu partisi. Retensi pendek karena tidak ada yang perlu dibangun ulang dari sini.

**`tbe.supplier.v1` — 1 partisi, kunci `supplier`, retensi 7 hari.**
Volume sangat rendah, tetapi urutan `degraded` lalu `recovered` per supplier wajib terjaga. Satu partisi sudah menjamin itu dan paling sederhana.

**`tbe.dead-letter.v1` — 3 partisi, retensi 30 hari.**
Menampung pesan yang tidak dapat diurai atau tidak sesuai kontrak dari topik mana pun. Retensi lebih panjang dari topik analitik karena isinya perlu diperiksa manusia, dan itu jarang terjadi pada hari yang sama.

## Versi pada nama topik

Akhiran `.v1` bukan hiasan. Perubahan bentuk payload yang tidak kompatibel ditangani dengan menerbitkan ke topik `.v2` sementara consumer lama masih membaca `.v1`, bukan dengan mengubah bentuk pesan di topik yang sedang berjalan. Amplop pesan juga membawa `eventVersion` untuk perubahan yang masih kompatibel.
