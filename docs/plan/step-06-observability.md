# Step 06 — Observability baseline

**Fase 1** · Milestone 2 · Estimasi 4 jam · Prasyarat: Step 05

## Tujuan

Memasang penelusuran dan metrik sekali di lapisan bersama, sehingga setiap service yang dibuat setelah ini otomatis terpantau. Memasang observability setelah sepuluh service jadi berarti menyentuh sepuluh service.

## Prompt

```
Tambahkan lapisan observability ke packages/shared-kernel sehingga setiap service
otomatis terinstrumentasi hanya dengan memanggil satu fungsi.

Baca docs/plan/CONVENTIONS.md dan PRD NFR-16 serta NFR-17 terlebih dahulu.

1. Penelusuran terdistribusi dengan OpenTelemetry
   - Fungsi initTracing(serviceName) yang dipanggil paling awal di index.ts
   - Auto-instrumentation untuk: Express, undici, KafkaJS, amqplib, ioredis, Prisma
   - Exporter OTLP ke Jaeger
   - Konteks trace merambat lewat header HTTP dan lewat amplop pesan
     (tambahkan traceparent ke amplop di packages/event-contracts)
   - Ini yang membuat satu permintaan pengguna bisa ditelusuri melewati
     gateway, search, lima adapter supplier, sampai publikasi peristiwa

2. Metrik dengan prom-client
   - Endpoint /metrics di setiap service
   - Metrik baku otomatis: durasi permintaan HTTP per route dan status,
     jumlah permintaan, proses Node
   - Registry metrik kustom yang bisa dipakai service untuk mendaftarkan
     metrik domainnya sendiri
   - Siapkan metrik yang akan dipakai nanti:
     supplier_request_duration_seconds (label: supplier, operation, outcome)
     supplier_circuit_state (label: supplier)
     search_cache_hits_total dan search_cache_misses_total
     booking_saga_step_total (label: step, outcome)

3. Korelasi log dan trace
   - Setiap baris log menyertakan traceId dan spanId aktif
   - Ini yang memungkinkan melompat dari log ke trace di Jaeger

4. Span kustom
   - Helper withSpan(name, attributes, fn) untuk membungkus operasi penting
     dengan span bernama
   - Konvensi penamaan span: <domain>.<operasi>, contoh supplier.price_check

5. Prometheus dan Grafana
   - Tambahkan kedua layanan ke infra/docker-compose.yml
   - Konfigurasi scrape untuk seluruh service
   - Satu dashboard Grafana awal berisi: latensi p50/p95/p99 per service,
     tingkat galat, dan status pemutus sirkuit per supplier
   - Simpan dashboard sebagai JSON di infra/grafana/ supaya ikut versi kontrol

6. Verifikasi
   - Buat satu service contoh sementara, atau pakai mock-supplier, untuk
     membuktikan bahwa trace muncul di Jaeger dan metrik muncul di Prometheus
   - Hapus kode verifikasi sementara setelah terbukti

Tulis test untuk: traceId muncul di log, konteks trace merambat lewat amplop pesan,
dan helper withSpan membuat span dengan atribut yang benar.

Setelah selesai, commit: feat: add observability baseline with tracing and metrics
```

## Definisi Selesai

- [ ] Satu permintaan menghasilkan trace utuh di Jaeger, melewati batas service
- [ ] Konteks trace merambat lewat Kafka dan RabbitMQ, bukan hanya HTTP
- [ ] Setiap baris log memuat `traceId` dan `correlationId`
- [ ] `/metrics` tersedia dan ter-scrape Prometheus
- [ ] Dashboard Grafana awal tampil dan tersimpan sebagai JSON di repo
- [ ] Menambahkan observability ke service baru cukup satu pemanggilan fungsi
- [ ] Commit terbuat

## Catatan

Perambatan konteks trace lewat amplop pesan sering dilewatkan. Tanpa itu, trace terputus tepat di titik paling menarik — ketika alur berpindah dari HTTP ke saga asinkron. Tangkapan layar trace utuh inilah yang akan masuk README di Step 29.
