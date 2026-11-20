# analytics-service

Konsumen analitik (Step 27, FR-31). Membaca **seluruh** topik Kafka dengan consumer group-nya sendiri, menghitung agregat ke PostgreSQL, dan menyajikan laporan untuk panel operator di `GET /ops/analytics/summary`. Tidak satu baris pun di service penerbit berubah untuk menambahkannya — itulah demonstrasi yang diminta Step 27.

## Menjalankan

```bash
DATABASE_URL=postgresql://... pnpm --filter @tbe/analytics-service db:deploy
DATABASE_URL=postgresql://... KAFKA_BROKERS=localhost:29092 pnpm --filter @tbe/analytics-service start
```

Port 4010. Env lengkap di [`src/config.ts`](src/config.ts).

## Keputusan

**Satu bentuk agregat: penghitung `(hari, metrik, dimensi) → nilai`.** Corong, performa supplier, kota terpopuler, dan sebab kegagalan semuanya penjumlahan. Satu tabel membuat replay sederhana (kosongkan, baca ulang) dan laporan baru yang hanya menggabungkan penghitung tidak butuh migrasi. Ditolak: tabel per laporan — lebih "bertipe", tetapi setiap laporan menjadi migrasi plus logika replay sendiri. ClickHouse ditolak PRD Bab 12.

**Hari = tanggal UTC dari `occurredAt` peristiwa**, bukan waktu diproses. Replay sebulan kemudian harus menaruh peristiwa di hari yang sama dengan pemrosesan pertama.

**Penambahan atomik di SQL, bukan di ORM.** `INSERT ... ON CONFLICT DO UPDATE SET value = analytics_counters.value + EXCLUDED.value`. Baca-ubah-tulis lewat Prisma kehilangan tambahan saat dua instance menulis penghitung yang sama, tanpa galat.

**Minimal sekali → tepat sekali di agregat.** `analytics_processed_events(event_id)` ditulis dalam transaksi yang SAMA dengan penghitung; pesan yang dibaca ulang setelah penyeimbangan consumer group ditolak oleh kunci primer.

**Supplier untuk peristiwa yang tidak menyebutnya.** `booking.price_changed` dan `booking.failed` tidak membawa supplier; pemetaan `booking_id → supplier` dicatat dari `booking.created`. Aman tanpa kunci karena ketiganya di topik yang sama dan berkunci `bookingId` — berurutan di satu partisi.

**Analitik tidak menulis ke Kafka sama sekali.** Pembungkus consumer @tbe/messaging mengirim pesan cacat ke dead letter; di sini produsennya diganti pengamat yang hanya mencatat. Pesan cacat yang sama sudah dikirim ke dead letter oleh consumer pemiliknya, dan analitik yang ikut mengirim menggandakan setiap entri — persis di tempat operator mencari penyebab insiden.

**Penerjemah peristiwa berupa tabel `Record<EventType, …>`, bukan `switch` dengan `default`.** Jenis peristiwa baru di kontrak gagal dikompilasi sampai diberi baris, jadi tidak ada cabang "jenis tak dikenal" yang tidak pernah tercapai — dan tidak ada penguraian payload dengan skema jenis yang salah, yang akan melempar dan menahan partisi selamanya.

## Replay

```bash
# 1. hentikan analytics-service
DATABASE_URL=... KAFKA_BROKERS=... pnpm --filter @tbe/analytics-service replay
# 2. nyalakan lagi — ia membaca setiap topik dari awal
```

Urutan di [`src/application/replay.ts`](src/application/replay.ts):

1. Ditolak (exit 1) bila consumer group masih punya anggota.
2. Offset diputar ke awal LEBIH DULU, baru tabel dikosongkan. Bila pengosongan gagal, service yang menyala menolak semua pesan sebagai duplikat dan agregat lama tetap utuh. Urutan sebaliknya meninggalkan agregat kosong dengan offset di ujung topik.
3. Penghitung, pemetaan supplier, dan daftar pesan dikosongkan dalam satu `TRUNCATE`.

**Lambat:** `admin.resetOffsets` kafkajs menulis offset lewat consumer sementara yang bergabung ke group — ±8 detik per topik di broker lokal, ±50 detik untuk enam topik. Topik diputar satu per satu: dua consumer sementara di group yang sama saling memicu penyeimbangan ulang.

**Batas:** "awal topik" adalah awal yang masih disimpan broker. `tbe.search.v1` dan `tbe.supplier.v1` beretensi 7 hari; setelah replay, agregat pencarian dan degradasi supplier yang lebih tua dari itu hilang. Topik pemesanan dan pembayaran beretensi 90 hari.

## Yang tidak ada di laporan

- **"Lihat detail" di corong.** Tidak ada peristiwa yang mengumumkan halaman properti dibuka. Menambahkannya berarti mengubah search-service dan apps/web — tepat yang tidak boleh dilakukan konsumen baru.
- **Latensi per supplier.** `search.performed` hanya membawa latensi seluruh pencarian. Latensi per supplier ada di halaman kesehatan panel, dari catatan percobaan supplier-service.
- **Kontribusi hasil per supplier.** Yang tersedia adalah supplier mana yang menjawab, bukan berapa hasilnya.

## Pengujian

```bash
pnpm --filter @tbe/analytics-service test               # unit, domain ≥ 95%, lainnya ≥ 85%
pnpm --filter @tbe/analytics-service test:integration   # Postgres + Kafka sungguhan
```

Uji integrasi memakai `INTEGRATION_DATABASE_URL` dan `INTEGRATION_KAFKA_BROKERS` bila keduanya diisi, selain itu Testcontainers; tanpa keduanya dan tanpa Docker, uji GAGAL. Yang dibuktikan: penambahan serentak (50 penulis → 50), deduplikasi serentak (10 penulis atas pesan yang sama → 1), atomisitas transaksi, CHECK tulisan tangan, kolom DATE di zona waktu proses bukan UTC — dan replay: bangun dari Kafka, replay ditolak saat consumer hidup, hapus, bangun ulang, hasil sama persis, offset consumer group lain tidak bergeser, dead letter tidak bertambah.

Kedua jalur sudah dijalankan: env `INTEGRATION_*` terhadap Postgres dan Kafka native, dan Testcontainers di CI (`integration`, PR #13).
