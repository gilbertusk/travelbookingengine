# Topik Kafka

Daftar topik beserta jumlah partisi dan alasannya. Topik dibuat lewat skrip, bukan otomatis — lihat `KAFKA_AUTO_CREATE_TOPICS_ENABLE: 'false'` pada `docker-compose.yml`.

> **Status: kerangka.** Daftar final dan skrip pembuatannya disusun pada [Step 05](../docs/plan/step-05-messaging.md). Berkas ini sengaja dibuat sekarang agar keputusan partisi dipikirkan saat topik dirancang, bukan setelah semuanya terlanjur berjalan dengan nilai bawaan.

## Kenapa pembuatan otomatis dimatikan

Dengan pembuatan otomatis, salah ketik nama topik pada producer tidak menghasilkan galat apa pun — Kafka membuat topik baru bernama salah, pesan masuk ke sana, dan tidak ada consumer yang membacanya. Kegagalan seperti ini tidak bersuara dan biasanya baru ketahuan saat data yang dinanti tidak pernah tiba.

## Yang menentukan jumlah partisi

Dua hal, dan keduanya perlu dijawab per topik:

1. **Apa kunci partisinya, dan urutan apa yang harus terjaga.** Kafka hanya menjamin urutan di dalam satu partisi. Peristiwa pemesanan harus berkunci `bookingId` agar seluruh peristiwa satu pemesanan tiba berurutan pada satu consumer.
2. **Berapa banyak consumer paralel yang dibutuhkan.** Jumlah consumer aktif dalam satu group tidak pernah melebihi jumlah partisi. Partisi terlalu sedikit membatasi throughput; terlalu banyak menambah beban tanpa manfaat pada skala ini.

## Daftar topik

| Topik                  | Partisi | Kunci partisi | Alasan |
| ---------------------- | ------- | ------------- | ------ |
| _disusun pada Step 05_ |         |               |        |

## Retensi

| Topik                  | Retensi | Alasan |
| ---------------------- | ------- | ------ |
| _disusun pada Step 05_ |         |        |

Topik yang dipakai untuk event sourcing status pemesanan membutuhkan retensi panjang atau pemadatan log, karena Step 27 harus dapat membangun ulang seluruh agregat dari awal topik. Topik analitik murni boleh beretensi pendek.
