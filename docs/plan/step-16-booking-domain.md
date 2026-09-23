# Step 16 — booking-service: domain dan state machine

**Fase 3** · Milestone 4 · Estimasi 6 jam · Prasyarat: Step 15

## Tujuan

Memodelkan siklus hidup pemesanan sebagai state machine eksplisit sebelum menyentuh integrasi apa pun. NFR-06 melarang keadaan menggantung, dan satu-satunya cara menjamin itu adalah membuat transisi tidak sah menjadi mustahil pada tingkat tipe.

## Prompt

```
Buat apps/booking-service, dimulai dari domain murni tanpa integrasi apa pun.

Baca terlebih dahulu:
- docs/plan/CONVENTIONS.md, terutama bagian 3 soal union diskriminan
- PRD Bab 8 glosarium, NFR-06, NFR-10

Tulis test lebih dulu. Seluruh step ini bisa diuji tanpa database dan tanpa jaringan.

1. State machine pemesanan
   Keadaan:
   - DRAFT        baru dibuat, belum ada apa-apa
   - PRICE_CHECKED harga terverifikasi, menunggu persetujuan bila berubah
   - HELD         inventaris tertahan, menunggu pembayaran
   - PAID         pembayaran diterima, menunggu konfirmasi supplier
   - CONFIRMED    supplier memberi booking reference. Keadaan final
   - FAILED       gagal, kompensasi sedang atau sudah berjalan
   - REFUNDED     dana dikembalikan. Keadaan final
   - CANCELLED    dibatalkan pengguna. Keadaan final
   - EXPIRED      hold kedaluwarsa tanpa pembayaran. Keadaan final
   - NEEDS_REVIEW status supplier tidak dapat dipastikan. Keadaan final
                  yang membutuhkan tindakan manusia

   Ketentuan:
   - Modelkan sebagai union diskriminan. Setiap keadaan hanya membawa data yang
     relevan untuknya. CONFIRMED wajib punya supplierRef; DRAFT tidak boleh punya
   - Definisikan tabel transisi yang sah sebagai data
   - Fungsi transisi mengembalikan Result. Transisi tidak sah adalah galat,
     bukan diabaikan diam-diam
   - Setiap keadaan final tidak punya transisi keluar
   - Buktikan dengan test bahwa dari setiap keadaan tidak final, selalu ada
     jalur menuju keadaan final. Ini yang menjamin NFR-06

2. Entitas dan value object
   - Booking, GuestDetails, BookingLineItem
   - IdempotencyKey sebagai value object
   - Seluruh nilai uang memakai packages/money

3. Peristiwa domain
   - Setiap transisi menghasilkan peristiwa domain
   - Peristiwa domain terpisah dari peristiwa Kafka. Pemetaan ke amplop Kafka
     terjadi di lapisan aplikasi

4. Skema Prisma
   - bookings: id, userId, status, supplierId, supplierRef, propertyId,
     ratePlanRef, checkIn (DATE), checkOut (DATE), guests, amount (integer),
     currency, idempotencyKey unik, heldUntil, createdAt, updatedAt
   - booking_events: id, bookingId, eventType, payload, occurredAt.
     Append only. Ini sumber audit trail untuk NFR-10
   - Perhatikan CONVENTIONS.md bagian 9: checkIn dan checkOut bertipe DATE,
     bukan TIMESTAMP. Ini bukan detail kecil
   - Indeks pada idempotencyKey, userId, status, dan heldUntil

5. Repository
   - Port BookingRepository di application
   - Implementasi Prisma di infrastructure
   - Penyimpanan booking dan booking_events terjadi dalam satu transaksi database

Test yang wajib:
- Seluruh transisi sah berhasil
- Seluruh transisi tidak sah ditolak dengan galat yang jelas
- Dari setiap keadaan tidak final terdapat jalur menuju keadaan final
- Keadaan final tidak punya transisi keluar
- Data yang tidak relevan tidak dapat melekat pada keadaan yang salah,
  dibuktikan lewat pemeriksaan tipe

Jangan menulis integrasi apa pun di step ini. Tanpa Redis, tanpa broker,
tanpa panggilan ke supplier.

Commit: feat: add booking domain and state machine
```

## Definisi Selesai

- [ ] Seluruh keadaan dimodelkan sebagai union diskriminan
- [ ] Tabel transisi dideklarasikan sebagai data, bukan tersebar di percabangan
- [ ] Transisi tidak sah menghasilkan galat, bukan diabaikan
- [ ] Terbukti dengan test bahwa tidak ada keadaan buntu yang tidak final
- [ ] `checkIn` dan `checkOut` bertipe `DATE`
- [ ] `booking_events` bersifat append only dan tersimpan dalam transaksi yang sama
- [ ] Domain tidak mengimpor apa pun dari infrastruktur — lint membuktikannya
- [ ] Cakupan test domain ≥ 95%
- [ ] Commit terbuat

## Catatan

Keadaan `NEEDS_REVIEW` sering dianggap tanda kegagalan desain. Justru sebaliknya: mengakui bahwa sebagian kasus tidak dapat diselesaikan otomatis, dan menyediakan tempat yang jelas untuknya, lebih baik daripada berpura-pura setiap kasus punya jawaban otomatis lalu meninggalkan pemesanan menggantung.
