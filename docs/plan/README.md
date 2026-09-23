# Playbook Implementasi — Travel Booking Engine

Rencana kerja per-step. Setiap file berisi satu prompt yang dijalankan dalam satu sesi kerja.

## Cara pakai

1. Buka file step sesuai urutan
2. Baca bagian **Tujuan** dan **Definisi Selesai** dulu, supaya kamu tahu apa yang dinilai
3. Salin isi blok **Prompt** apa adanya ke Claude Code
4. Setelah selesai, centang Definisi Selesai. Jangan lanjut kalau ada yang belum tercentang
5. Commit di akhir setiap step dengan format conventional commit

## Aturan yang berlaku di semua step

Tiga dokumen berikut adalah kontrak. Setiap prompt merujuk ke sini, jangan dilewati.

| Dokumen | Isi |
|---|---|
| [CONVENTIONS.md](CONVENTIONS.md) | Struktur kode, aturan layering, batas ukuran, error handling, testing |
| [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md) | Arah visual, token desain, aturan komponen, aksesibilitas |
| [../../.claude/prds/travel-booking-engine.prd.md](../../.claude/prds/travel-booking-engine.prd.md) | Kebutuhan, metrik, glosarium domain |

## Prinsip kerja

- **Test lebih dulu.** Setiap step yang menghasilkan logika menulis test sebelum implementasi
- **Satu step, satu commit.** Kalau satu step menghasilkan lebih dari satu commit, step-nya terlalu besar
- **Jangan lompat.** Step disusun agar setiap tahap punya fondasi yang sudah teruji
- **Review sebelum lanjut.** Jalankan `/code-review` di akhir step yang menyentuh logika bisnis

---

## Daftar Step

### Fase 0 — Fondasi Repo (Milestone 1)

| # | Step | Estimasi |
|---|---|---|
| 01 | [Monorepo dan tooling](step-01-monorepo-tooling.md) | 3 jam |
| 02 | [Infrastruktur Docker Compose](step-02-infrastructure.md) | 3 jam |
| 03 | [Package shared-kernel](step-03-shared-kernel.md) | 5 jam |
| 04 | [Mock supplier service](step-04-mock-supplier.md) | 6 jam |

### Fase 1 — Platform (Milestone 2)

| # | Step | Estimasi |
|---|---|---|
| 05 | [Package event-contracts dan messaging](step-05-messaging.md) | 5 jam |
| 06 | [Observability baseline](step-06-observability.md) | 4 jam |
| 07 | [auth-service](step-07-auth-service.md) | 5 jam |
| 08 | [api-gateway](step-08-api-gateway.md) | 4 jam |
| 09 | [Frontend: fondasi dan design system](step-09-frontend-foundation.md) | 6 jam |

### Fase 2 — Pencarian (Milestone 3)

| # | Step | Estimasi |
|---|---|---|
| 10 | [Package supplier-adapters](step-10-supplier-adapters.md) | 6 jam |
| 11 | [supplier-service dan ketahanan](step-11-supplier-service.md) | 6 jam |
| 12 | [Package money dan pricing-service](step-12-pricing.md) | 5 jam |
| 12b | [Katalog properti dan pemetaan supplier](step-12b-property-catalog.md) | 5 jam |
| 13 | [search-service: fan-out dan cache](step-13-search-service.md) | 8 jam |
| 14 | [Frontend: pencarian dan hasil](step-14-frontend-search.md) | 8 jam |
| 15 | [Uji beban pencarian](step-15-search-load-test.md) | 4 jam |

### Fase 3 — Pemesanan (Milestone 4)

| # | Step | Estimasi |
|---|---|---|
| 16 | [booking-service: domain dan state machine](step-16-booking-domain.md) | 6 jam |
| 17 | [Hold dan price check](step-17-hold-price-check.md) | 5 jam |
| 18 | [payment-service](step-18-payment-service.md) | 6 jam |
| 19 | [Saga dan kompensasi](step-19-saga.md) | 8 jam |
| 20 | [Uji integrasi dengan Testcontainers](step-20-integration-tests.md) | 6 jam |
| 21 | [Frontend: alur pemesanan](step-21-frontend-booking.md) | 8 jam |
| 22 | [Uji beban konkurensi](step-22-concurrency-test.md) | 4 jam |

### Fase 4 — Pasca-pemesanan (Milestone 5)

| # | Step | Estimasi |
|---|---|---|
| 23 | [voucher-service](step-23-voucher-service.md) | 4 jam |
| 24 | [notification-service](step-24-notification-service.md) | 4 jam |
| 25 | [Pembatalan dan refund](step-25-cancellation.md) | 7 jam |
| 26 | [Frontend: daftar pemesanan dan pembatalan](step-26-frontend-bookings.md) | 5 jam |

### Fase 5 — Pembuktian (Milestone 6)

| # | Step | Estimasi |
|---|---|---|
| 27 | [analytics-service dan panel operator](step-27-analytics-ops.md) | 8 jam |
| 28 | [Chaos test dan rekonsiliasi](step-28-chaos-reconciliation.md) | 8 jam |
| 29 | [ADR dan README bukti](step-29-adr-readme.md) | 5 jam |
| 30 | [CI/CD dan deployment](step-30-cicd-deploy.md) | 7 jam |

**Total: 174 jam** ≈ 12–14 minggu paruh waktu.

---

## Keputusan yang sudah diambil

Seluruh tujuh pertanyaan terbuka sudah diputuskan pada 2026-09-23. Tidak ada step yang terblokir. Setiap keputusan wajib diangkat menjadi ADR pada Step 29.

| # | Keputusan | Berdampak pada |
|---|---|---|
| Q5 | Katalog internal untuk data statis, dengan tabel pemetaan ke pengenal supplier. Harga dan ketersediaan tetap dari supplier | Step 10, **12b**, 13 |
| Q2 | Dua mata uang: IDR dan USD | Step 12 |
| Q1 | Sandbox Midtrans di belakang port `PaymentGateway`. Chaos test menyuntikkan kegagalan di batas port, bukan di penyedia | Step 18, 28 |
| Q3 | Pembatalan berjenjang dengan pengembalian sebagian: 100% sampai 7 hari, 50% sampai 24 jam, 0% setelahnya | Step 25 |
| Q6 | Panel operator sebagai aplikasi terpisah `apps/ops`, tidak diakses publik | Step 27, 30 |
| Q4 | Rekonsiliasi termasuk MVP | Step 28 |
| Q7 | Demo aktif selama masa melamar di tingkat gratis, video permanen sebagai cadangan | Step 30 |

## Jalur minimum bila waktu menipis

Kalau harus memangkas, potong dari sini dan jangan dari yang lain:

**Boleh dipangkas:** Step 27 (analytics), FR berprioritas Should dan Could, dark mode, halaman peta.

**Tidak boleh dipangkas:** Step 04, 11, 13, 19, 20, 22, 28, 29. Delapan step ini yang membuat project punya nilai. Tanpa salah satunya, klaim di README jadi tidak terbukti.
