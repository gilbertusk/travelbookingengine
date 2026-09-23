# Step 02 — Infrastruktur Docker Compose

**Fase 0** · Milestone 1 · Estimasi 3 jam · Prasyarat: Step 01

## Tujuan

Seluruh infrastruktur berjalan dengan satu perintah. Ini memenuhi NFR-21 dan menjadi syarat agar penilai portofolio bisa menjalankan project tanpa membaca dokumentasi panjang.

## Prompt

```
Buat berkas infrastruktur Docker Compose untuk project ini.

Baca docs/plan/CONVENTIONS.md terlebih dahulu.

Buat infra/docker-compose.yml berisi layanan berikut:

1. postgres — PostgreSQL 16
   - Satu instance, tapi siapkan skrip init yang membuat database terpisah untuk tiap
     service: auth, supplier, pricing, booking, payment, voucher, analytics
   - Volume persisten, healthcheck dengan pg_isready

2. redis — Redis 7
   - Aktifkan keyspace notification untuk event expired (notify-keyspace-events Ex),
     ini dibutuhkan untuk pelepasan hold otomatis
   - Volume persisten, healthcheck

3. rabbitmq — RabbitMQ 3.13 dengan management plugin
   - Port 5672 dan 15672
   - Healthcheck dengan rabbitmq-diagnostics

4. kafka — Apache Kafka mode KRaft, tanpa Zookeeper
   - Single broker, auto create topic dimatikan
   - Healthcheck

5. kafka-ui — Kafbat UI, terhubung ke broker

6. minio — penyimpanan objek untuk voucher PDF
   - Console dan API, bucket awal bernama vouchers

7. jaeger — all-in-one untuk penelusuran terdistribusi

8. mailpit — penangkap surel untuk pengembangan lokal

Ketentuan:
- Seluruh layanan berada di satu network bernama tbe
- Setiap layanan punya healthcheck, dan service aplikasi nanti memakai depends_on
  dengan condition service_healthy
- Port dipetakan ke host dengan nilai yang tidak bentrok dengan layanan umum
- Kredensial diambil dari berkas .env di folder infra, sediakan infra/.env.example
- Jangan menaruh kredensial apa pun langsung di docker-compose.yml

Tambahan:
- infra/init-db.sh untuk membuat database per service
- Skrip di package.json root: infra:up, infra:down, infra:reset, infra:logs
- infra/README.md berisi daftar port, kredensial pengembangan, dan tautan UI

Terakhir, buat berkas infra/topics.md yang mendaftarkan seluruh topik Kafka yang
akan dipakai beserta jumlah partisi dan alasannya. Topik dibuat lewat skrip,
bukan auto-create. Daftar topik menyusul di Step 05, untuk sekarang cukup
kerangka dokumennya.

Setelah selesai, jalankan pnpm infra:up, pastikan seluruh healthcheck hijau,
lalu commit: chore: add local infrastructure with docker compose
```

## Definisi Selesai

- [ ] `pnpm infra:up` menjalankan seluruh layanan dan semua healthcheck hijau
- [ ] Database terpisah per service terbentuk otomatis
- [ ] Redis merespons dan keyspace notification aktif (verifikasi dengan `CONFIG GET notify-keyspace-events`)
- [ ] Kafka UI, RabbitMQ Management, MinIO Console, Jaeger, dan Mailpit dapat dibuka di peramban
- [ ] Tidak ada kredensial di dalam `docker-compose.yml`
- [ ] `pnpm infra:reset` mengembalikan keadaan bersih
- [ ] Commit terbuat

## Catatan

Keyspace notification Redis sering terlupa dan baru ketahuan saat Step 17 ketika hold tidak pernah terlepas. Verifikasi sekarang.
