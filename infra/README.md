# Infrastruktur Lokal

Seluruh infrastruktur pengembangan berjalan dengan satu perintah. Ini memenuhi NFR-21 pada PRD, dan menjadi syarat agar penilai portofolio dapat menjalankan project tanpa membaca dokumentasi panjang.

## Menjalankan

```bash
cp infra/.env.example infra/.env
pnpm infra:up
```

| Perintah           | Kegunaan                                                                    |
| ------------------ | --------------------------------------------------------------------------- |
| `pnpm infra:up`    | Menyalakan seluruh layanan dan menunggu sampai sehat                        |
| `pnpm infra:down`  | Mematikan, volume tetap dipertahankan                                       |
| `pnpm infra:reset` | Mematikan **dan menghapus seluruh volume**. Database dibuat ulang dari awal |
| `pnpm infra:logs`  | Mengikuti log seluruh layanan                                               |
| `pnpm infra:ps`    | Status dan kesehatan tiap layanan                                           |

## Antarmuka

| Layanan             | URL                    | Kredensial pengembangan |
| ------------------- | ---------------------- | ----------------------- |
| Kafka UI            | http://localhost:8090  | —                       |
| RabbitMQ Management | http://localhost:15672 | `tbe` / `tbe_local_dev` |
| MinIO Console       | http://localhost:9001  | `tbe` / `tbe_local_dev` |
| Jaeger              | http://localhost:16686 | —                       |
| Mailpit             | http://localhost:8025  | —                       |

## Port

| Layanan        | Host  | Dalam container |
| -------------- | ----- | --------------- |
| PostgreSQL     | 5433  | 5432            |
| Redis          | 6380  | 6379            |
| RabbitMQ       | 5672  | 5672            |
| Kafka          | 29092 | 29092           |
| MinIO API      | 9000  | 9000            |
| OTLP gRPC      | 4317  | 4317            |
| OTLP HTTP      | 4318  | 4318            |
| SMTP (Mailpit) | 1025  | 1025            |

PostgreSQL dan Redis sengaja dipetakan ke port tidak lazim agar tidak bentrok dengan instalasi lokal yang mungkin sudah berjalan di mesin.

## Database per service

Satu database terpisah untuk setiap service, dibuat otomatis oleh `init-db.sh` saat inisialisasi pertama:

```
auth  search  supplier  pricing  booking  payment  voucher  notification  analytics
```

Pemisahan ini adalah keputusan arsitektur, bukan preferensi. Tanpanya, join lintas service menjadi mungkin — dan begitu satu join ditulis, batas kepemilikan data hilang.

Menambah database baru: tambahkan namanya ke `SERVICE_DATABASES` di `infra/.env`, lalu jalankan `pnpm infra:reset`. Skrip inisialisasi hanya berjalan saat volume masih kosong.

Koneksi dari host:

```
postgresql://tbe:tbe_local_dev@localhost:5433/<nama_database>
```

## Catatan per layanan

**Redis** berjalan dengan `--notify-keyspace-events Ex`. Ini yang dipakai Step 17 untuk melepas hold secara otomatis saat kedaluwarsa. Verifikasi bahwa flag ini aktif:

```bash
docker exec tbe-redis redis-cli -a tbe_local_dev CONFIG GET notify-keyspace-events
```

Redis tidak menjamin pengiriman notifikasi kepada klien yang sedang terputus, jadi Step 17 tetap menyediakan penyapu berkala sebagai jaring pengaman.

**Kafka** berjalan dalam mode KRaft, tanpa Zookeeper. Pembuatan topik otomatis **dimatikan** — topik dibuat lewat skrip pada Step 05. Pembuatan otomatis menyembunyikan salah ketik nama topik sebagai topik baru yang sunyi, dan pesan yang salah alamat tidak pernah sampai ke consumer mana pun.

**MinIO** membuat bucket awal lewat container `minio-init` yang berjalan sekali lalu berhenti. Container dalam status `exited` untuk layanan ini adalah normal.

**Jaeger** menerima OTLP di 4317 (gRPC) dan 4318 (HTTP). Instrumentasi dipasang pada Step 06.

## Menjalankan perintah di dalam container dari Git Bash

Git Bash di Windows mengubah path absolut pada argumen menjadi path Windows, sehingga `docker exec` gagal dengan pesan seperti `stat C:/Program Files/Git/opt/kafka/...: no such file or directory`. Awali perintahnya dengan `MSYS_NO_PATHCONV=1`:

```bash
MSYS_NO_PATHCONV=1 docker exec tbe-kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list
```

Perintah tanpa path absolut, seperti `psql` atau `redis-cli`, tidak terpengaruh.

## Kredensial

Seluruh kredensial berasal dari `infra/.env`, yang tidak diikutkan ke versi kontrol. Tidak ada nilai rahasia di dalam `docker-compose.yml`.

Nilai di `.env.example` hanya untuk pengembangan lokal. Kredensial produksi dikelola lewat pengelola rahasia platform — lihat Step 30.
