# Konvensi Kode

Kontrak yang berlaku di seluruh repo. Setiap prompt step merujuk ke dokumen ini.

---

## 1. Struktur layanan

Setiap service backend memiliki struktur yang **identik**. Tidak ada pengecualian — keseragaman inilah yang membuat sepuluh service tetap bisa dinavigasi.

```
apps/<nama>-service/
├── src/
│   ├── domain/          Entitas, value object, aturan bisnis murni
│   ├── application/     Use case, orkestrasi, port (interface)
│   ├── infrastructure/  Implementasi port: db, cache, http client, broker
│   ├── http/            Route, controller, middleware, skema request
│   ├── messaging/       Consumer Kafka dan RabbitMQ
│   ├── config.ts        Skema env + parsing, gagal saat startup bila tidak valid
│   └── index.ts         Composition root: wiring dan bootstrap
├── prisma/schema.prisma
├── tests/
│   └── integration/
├── Dockerfile
└── package.json
```

### Aturan arah ketergantungan

```
http ──┐
       ├──> application ──> domain
messaging ──┘                  ▲
                               │
infrastructure ────────────────┘ (hanya mengimplementasi port)
```

Aturan yang tidak boleh dilanggar:

- `domain/` **tidak boleh** mengimpor apa pun dari `infrastructure/`, `http/`, `messaging/`, atau pustaka pihak ketiga selain utilitas murni
- `application/` mendefinisikan **port** berupa interface. Ia tidak tahu implementasinya
- `infrastructure/` mengimplementasi port. Ia boleh tahu tentang database dan broker
- Wiring hanya terjadi di `index.ts`

Kalau sebuah aturan bisnis butuh memanggil database untuk diuji, aturan itu salah tempat. Pindahkan ke `domain/` dan berikan datanya sebagai argumen.

---

## 2. Batas ukuran

| Unit | Normal | Maksimum |
|---|---|---|
| Fungsi | < 30 baris | 50 baris |
| File | 150–300 baris | 400 baris |
| Kedalaman nesting | 2 | 3 |
| Parameter fungsi | 3 | 4, lebih dari itu pakai objek |

Melewati maksimum berarti pecah, bukan minta pengecualian.

---

## 3. TypeScript

- `strict: true`, tanpa pengecualian
- **`any` dilarang.** Pakai `unknown` lalu persempit dengan validasi
- Hindari type assertion (`as`). Kalau terpaksa, sertakan komentar alasannya
- Utamakan `type` untuk bentuk data, `interface` untuk port yang diimplementasi
- Nilai yang tidak boleh berubah dideklarasikan `readonly`
- Union diskriminan untuk keadaan, bukan boolean bertumpuk

```ts
// Salah
type Booking = { isPaid: boolean; isConfirmed: boolean; isCancelled: boolean }

// Benar
type Booking =
  | { status: 'pending'; heldUntil: Date }
  | { status: 'confirmed'; supplierRef: string }
  | { status: 'cancelled'; reason: CancellationReason }
```

---

## 4. Imutabilitas

Wajib. Jangan pernah mengubah objek yang diterima.

```ts
// Salah
function applyMarkup(rate: Rate, pct: number): Rate {
  rate.price = rate.price * (1 + pct)
  return rate
}

// Benar
function applyMarkup(rate: Rate, pct: number): Rate {
  return { ...rate, price: multiply(rate.price, 1 + pct) }
}
```

Gunakan `map`, `filter`, `reduce`, spread. Hindari `push`, `splice`, `sort` pada array yang diterima sebagai argumen — `sort` mengubah di tempat, salin dulu.

---

## 5. Penanganan error

- **Tidak ada `catch` kosong.** Tidak ada `catch` yang hanya menulis log lalu diam
- Error domain adalah kelas bernama yang mewarisi `AppError` dari `shared-kernel`
- Error yang dapat diantisipasi dikembalikan sebagai nilai, bukan dilempar
- Error tak terduga dilempar dan ditangkap di batas sistem (middleware / consumer wrapper)
- Pesan error untuk pengguna tidak boleh memuat detail internal. Detail masuk log dengan `correlationId`

```ts
// Error yang bisa diantisipasi — kembalikan sebagai nilai
type PriceCheckResult =
  | { outcome: 'unchanged'; rate: Rate }
  | { outcome: 'changed'; oldRate: Rate; newRate: Rate }
  | { outcome: 'unavailable' }
```

---

## 6. Validasi

- Setiap masukan dari luar divalidasi dengan Zod di **batas sistem**: request HTTP, payload event, respons supplier, variabel env
- Skema disimpan berdampingan dengan tempat pemakaiannya, kecuali skema event yang tinggal di `packages/event-contracts`
- Respons supplier **wajib** divalidasi. Supplier adalah sumber data yang tidak tepercaya
- Tipe diturunkan dari skema dengan `z.infer`, jangan ditulis ganda

---

## 7. Penamaan

| Jenis | Aturan | Contoh |
|---|---|---|
| Variabel, fungsi | camelCase | `calculateMarkup` |
| Boolean | awalan `is`, `has`, `should`, `can` | `isRefundable` |
| Tipe, kelas, komponen | PascalCase | `RatePlan`, `BookingSaga` |
| Konstanta | UPPER_SNAKE_CASE | `SEARCH_TIMEOUT_MS` |
| File berisi komponen React | PascalCase | `RatePlanCard.tsx` |
| File lain | kebab-case | `price-check.ts` |
| Hook React | awalan `use` | `useSearchResults` |
| Port (interface) | akhiran peran | `SupplierGateway`, `BookingRepository` |

Istilah domain **wajib** mengikuti glosarium PRD Bab 8. Jangan menulis `hotel` untuk sesuatu yang di PRD disebut `property`.

---

## 8. Angka ajaib

Semua ambang, batas waktu, dan durasi menjadi konstanta bernama, ditempatkan di dekat pemakaiannya atau di `config.ts` bila berasal dari env.

```ts
const SEARCH_TIMEOUT_MS = 1_200
const HOLD_DURATION_MS = 15 * 60 * 1_000
const CIRCUIT_BREAKER_ERROR_THRESHOLD = 0.5
```

---

## 9. Uang dan waktu

Dua sumber bug paling mahal di domain ini.

**Uang**
- Dilarang memakai `number` untuk nilai uang
- Seluruh perhitungan lewat `packages/money`
- Nilai selalu membawa mata uangnya. Tidak ada angka uang tanpa mata uang
- Pembulatan dilakukan sekali di akhir, dan aturannya dinyatakan eksplisit

**Waktu**
- Tanggal masuk dan keluar adalah **tanggal lokal properti**, disimpan sebagai `DATE`, bukan `TIMESTAMP`
- Waktu kejadian sistem disimpan sebagai UTC `TIMESTAMPTZ`
- Jangan pernah mengonversi tanggal menginap ke UTC
- Zona waktu properti adalah bagian dari data properti

---

## 10. Testing

- **Test ditulis sebelum implementasi** untuk setiap logika domain dan use case
- Struktur Arrange-Act-Assert, dipisahkan komentar bila tidak jelas
- Nama test menjelaskan perilaku, bukan nama fungsi

```ts
test('mengembalikan outcome changed ketika harga supplier berbeda dari yang ditampilkan', () => {})
test('melepas hold ketika batas waktu terlampaui', () => {})
```

- Unit test berdampingan dengan kodenya: `price-check.ts` dan `price-check.test.ts`
- Integration test di `tests/integration/`, memakai Testcontainers dengan infrastruktur sungguhan
- Cakupan minimum 80%. Cakupan jalur kompensasi saga harus 100%
- Dilarang memakai tiruan untuk menguji jalur kompensasi

---

## 11. Log

- Terstruktur, JSON, lewat logger dari `shared-kernel`
- Setiap log membawa `correlationId` dan nama service
- Dilarang `console.log`
- Dilarang mencatat kata sandi, token, kredensial supplier, atau data kartu
- Level: `error` untuk yang butuh tindakan, `warn` untuk degradasi, `info` untuk peristiwa bisnis, `debug` untuk sisanya

---

## 12. Konfigurasi

- Seluruh env divalidasi dengan Zod saat startup. Env tidak valid berarti proses **berhenti**, bukan jalan dengan nilai bawaan
- Dilarang membaca `process.env` di luar `config.ts`
- Tidak ada kredensial di kode sumber, termasuk di file contoh dan test
- Setiap service punya `.env.example` yang lengkap

---

## 13. Frontend

Tambahan di luar aturan di atas.

```
apps/web/src/
├── app/                 Route Next.js
├── components/
│   ├── ui/              Primitif dari shadcn, jangan ditulis manual
│   └── <fitur>/         Komponen spesifik fitur
├── features/<fitur>/    Hook, query, tipe, dan logika fitur
├── lib/                 Utilitas lintas fitur
└── styles/
```

- Server Component sebagai bawaan. `'use client'` hanya bila benar-benar butuh interaksi, dan ditempatkan sedalam mungkin di pohon komponen
- Komponen presentasi tidak mengambil data sendiri. Data diambil di Server Component atau hook fitur
- Tidak ada `fetch` langsung di dalam komponen. Semua lewat lapisan `features/<fitur>/api.ts`
- Satu komponen satu tanggung jawab. Lebih dari 150 baris berarti perlu dipecah
- State server pakai TanStack Query, state UI pakai Zustand. Jangan menyimpan data server di Zustand

---

## 14. Commit

Format: `<type>: <deskripsi>`

Type: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`

Satu step menghasilkan satu commit. Pesan menjelaskan **apa yang berubah bagi sistem**, bukan daftar file.

---

## 15. Checklist sebelum menutup step

- [ ] Lint dan typecheck bersih
- [ ] Seluruh test lewat
- [ ] Cakupan memenuhi ambang
- [ ] Tidak ada `any`, `console.log`, `catch` kosong, atau kredensial
- [ ] Tidak ada file melewati 400 baris
- [ ] Istilah domain sesuai glosarium PRD
- [ ] `.env.example` diperbarui bila ada env baru
- [ ] Definisi Selesai pada file step tercentang semua
