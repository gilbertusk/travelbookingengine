# Step 11 — supplier-service dan ketahanan

**Fase 2** · Milestone 3 · Estimasi 6 jam · Prasyarat: Step 10

## Tujuan

Menjadikan supplier yang rapuh sebagai ketergantungan yang aman. Step ini yang memenuhi NFR-03 dan NFR-04, dan menjadi dasar klaim "satu supplier mati tidak menurunkan sistem".

## Prompt

```
Buat apps/supplier-service, service yang membungkus seluruh komunikasi dengan
supplier dengan lapisan ketahanan.

Baca docs/plan/CONVENTIONS.md serta PRD NFR-03, NFR-04, dan NFR-14 terlebih dahulu.

Tulis test lebih dulu.

1. Pemutus sirkuit per supplier
   - Memakai opossum, satu instance per supplier per operasi
   - Ambang, jendela, dan durasi terbuka dapat dikonfigurasi per supplier,
     disimpan sebagai konstanta bernama bukan angka ajaib
   - Keadaan pemutus dipublikasikan sebagai metrik supplier_circuit_state
   - Perubahan keadaan menerbitkan peristiwa Kafka supplier.degraded dan
     supplier.recovered
   - Keadaan pemutus dibagikan antar instance lewat Redis, supaya penggandaan
     horizontal tidak membuat tiap instance belajar sendiri-sendiri

2. Kebijakan percobaan ulang
   Berbasis jenis SupplierError dari Step 10:
   - timeout dan upstream_error: boleh dicoba ulang, backoff eksponensial dengan jitter
   - rate_limited: dicoba ulang setelah jeda lebih panjang
   - invalid_response: TIDAK dicoba ulang, langsung gagal
   - sold_out, not_found, price_changed: TIDAK dicoba ulang, ini jawaban sah
   - Operasi book TIDAK PERNAH dicoba ulang secara buta. Lihat butir 4

3. Pembatasan laju keluar
   - Token bucket per supplier berbasis Redis
   - Melindungi supplier dari dibanjiri oleh sistem kita sendiri

4. Percobaan ulang aman untuk book
   Ini implementasi US-05 pada PRD:
   - Bila book menghasilkan timeout, JANGAN mencoba book lagi
   - Panggil getBooking dengan idempotency key untuk memastikan status sebenarnya
   - Bila pemesanan sudah terbentuk, adopsi hasilnya
   - Bila belum, barulah book boleh diulang
   - Seluruh percobaan dicatat di tabel supplier_requests untuk rekonsiliasi

5. Pencatatan permintaan
   - Tabel supplier_requests: id, supplierId, operation, requestPayload,
     responsePayload, latencyMs, outcome, attemptNumber, idempotencyKey, createdAt
   - Payload yang disimpan sudah diredaksi dari kredensial
   - Dipakai untuk debugging dan untuk rekonsiliasi di Step 28

6. Antarmuka internal
   - HTTP internal yang dipakai search-service dan booking-service
   - Consumer RabbitMQ untuk perintah supplier.confirm dan supplier.cancel
   - Kedua jalur memakai use case yang sama, tidak ada duplikasi logika

7. Konfigurasi supplier
   - Tabel suppliers: kode, nama, tipe adapter, base URL, referensi kredensial,
     isActive, pengaturan batas waktu dan pemutus sirkuit
   - Endpoint operasi untuk mengaktifkan, menonaktifkan, dan mengubah konfigurasi
     (FR-29), dilindungi peran operator
   - Kredensial supplier TIDAK disimpan di tabel, hanya referensinya. Nilainya dari env

8. Metrik
   - supplier_request_duration_seconds dengan label supplier, operation, outcome
   - supplier_circuit_state
   - supplier_retry_total

Test yang wajib ada, memakai mock-supplier dengan penyuntikan kegagalan:
- Pemutus terbuka setelah ambang kegagalan tercapai, dan berhenti memanggil supplier
- Pemutus setengah terbuka memulihkan diri ketika supplier sehat kembali
- invalid_response tidak memicu percobaan ulang
- Timeout pada book memicu getBooking, bukan book ulang — ini test terpenting di step ini
- Pemesanan yang sudah terbentuk diadopsi, tidak dibuat ganda
- Keadaan pemutus dibagikan antar dua instance lewat Redis

Commit: feat: add supplier service with resilience layer
```

## Definisi Selesai

- [ ] Pemutus sirkuit bekerja per supplier dan keadaannya dibagikan lewat Redis
- [ ] Kebijakan percobaan ulang berbeda sesuai jenis galat — dibuktikan dengan test
- [ ] Timeout pada `book` memicu `getBooking`, bukan pengulangan buta — dibuktikan dengan test
- [ ] Pemesanan yang sudah terbentuk diadopsi tanpa membuat ganda
- [ ] Peristiwa `supplier.degraded` dan `supplier.recovered` terbit ke Kafka
- [ ] Seluruh permintaan tercatat dengan payload teredaksi
- [ ] Kredensial supplier tidak tersimpan di database
- [ ] Metrik muncul di Prometheus dan grafiknya terlihat di Grafana
- [ ] Cakupan test ≥ 85%
- [ ] Commit terbuat

## Catatan

Test "timeout pada book memicu getBooking" adalah satu-satunya test di project ini yang secara langsung mencegah kerugian uang sungguhan. Tulis dengan serius, dan sebut secara khusus di README nanti.
