# Step 07 — auth-service

**Fase 1** · Milestone 2 · Estimasi 5 jam · Prasyarat: Step 06

## Tujuan

Service pertama yang sungguhan. Selain memenuhi FR-34, step ini menetapkan cetak biru struktur yang akan diikuti sembilan service berikutnya.

## Prompt

```
Buat apps/auth-service, service backend pertama dalam project ini.

Baca docs/plan/CONVENTIONS.md terlebih dahulu. Struktur folder yang kamu buat di
step ini menjadi acuan untuk seluruh service berikutnya, jadi ikuti bagian 1
dengan tepat.

Tulis test lebih dulu untuk seluruh logika domain dan use case.

Cakupan fungsional: FR-34 dan FR-35 pada PRD.

1. Domain
   - Value object Email dengan validasi format
   - Value object Password dengan aturan kekuatan minimum, dan pembedaan tegas
     antara kata sandi mentah dan kata sandi ter-hash pada tingkat tipe
   - Entitas User
   - Aturan bisnis murni, tanpa impor apa pun dari infrastruktur

2. Application
   - Use case: registerUser, authenticateUser, refreshSession, revokeSession,
     getProfile, updateProfile
   - Port: UserRepository, PasswordHasher, TokenIssuer, Clock
   - Error yang dapat diantisipasi dikembalikan sebagai Result, bukan dilempar:
     email sudah terdaftar, kredensial salah, refresh token tidak sah

3. Infrastructure
   - PrismaUserRepository
   - Argon2PasswordHasher dengan parameter yang wajar, argon2id
   - JoseTokenIssuer: access token berumur pendek, refresh token berumur panjang
     dan disimpan ter-hash di database supaya bisa dicabut
   - Rotasi refresh token: setiap pemakaian menerbitkan yang baru dan membatalkan
     yang lama, dan pemakaian ulang token lama membatalkan seluruh sesi pengguna

4. HTTP
   - POST /auth/register, POST /auth/login, POST /auth/refresh,
     POST /auth/logout, GET /auth/me, PATCH /auth/me
   - Seluruh masukan divalidasi dengan Zod
   - Pembatasan laju khusus pada login dan register
   - Respons login dan register TIDAK memuat hash kata sandi atau data internal apa pun

5. Skema Prisma
   - users: id (uuid v7), email unik, passwordHash, name, createdAt, updatedAt
   - refresh_tokens: id, userId, tokenHash, expiresAt, revokedAt, replacedById
   - Migrasi dibuat dan dapat dijalankan

Keamanan yang wajib (PRD NFR-11 sampai NFR-15):
- Argon2id, bukan bcrypt, bukan SHA
- Rahasia JWT dari env, divalidasi saat startup, tidak ada nilai bawaan
- Pesan galat login tidak membedakan antara email tidak ada dan kata sandi salah
- Waktu respons login tidak boleh membocorkan keberadaan akun
- Tidak ada kredensial di kode maupun di test

Terakhir, tulis apps/auth-service/README.md berisi daftar endpoint, contoh
request, dan variabel env yang dibutuhkan. Buat juga .env.example.

Jalankan /code-review setelah implementasi selesai dan perbaiki temuan
CRITICAL dan HIGH sebelum commit.

Commit: feat: add auth service
```

## Definisi Selesai

- [ ] Struktur folder sama persis dengan CONVENTIONS.md bagian 1
- [ ] Aturan import boundary tidak dilanggar — `pnpm lint` membuktikannya
- [ ] Cakupan test ≥ 80%, domain dan use case ≥ 90%
- [ ] Rotasi refresh token bekerja, dan pemakaian ulang token lama mencabut seluruh sesi — dibuktikan dengan test
- [ ] Argon2id dipakai, parameter tercatat sebagai konstanta bernama
- [ ] Pesan galat login tidak membedakan penyebab — dibuktikan dengan test
- [ ] Tidak ada rahasia dengan nilai bawaan di `config.ts`
- [ ] Migrasi dibuat dan dapat dijalankan — **tertunda**, lihat Catatan
- [ ] `/code-review` dijalankan dan temuan CRITICAL serta HIGH ditutup — **belum dijalankan**
- [ ] Commit terbuat

## Catatan

Pemakaian ulang refresh token yang mencabut seluruh sesi adalah detail kecil yang menunjukkan kamu paham serangan pencurian token. Murah untuk dibuat, mahal nilainya saat ditanya.

### Temuan saat mengerjakan step ini

**1. `prisma@^7` ternyata memasang `8.0.0-rc`.** Rentang caret menarik release candidate dengan CLI yang sama sekali berbeda — berorientasi cloud (`prisma auth login`, `prisma project list`), dan `prisma generate` bahkan tidak terdaftar sebagai perintah. Versi CLI harus dipasangkan dengan versi `@prisma/client`, dan untuk Prisma sebaiknya dipin.

**2. Prisma 7 melarang `url` di dalam `schema.prisma`.** URL untuk Migrate pindah ke `prisma.config.ts`, dan `PrismaClient` menerimanya lewat driver adapter (`@prisma/adapter-pg`). Ini sebenarnya perbaikan: kredensial produksi tidak pernah perlu hadir dalam bentuk apa pun di dalam berkas skema.

**3. Generator berganti nama** dari `prisma-client-js` menjadi `prisma-client`, dan keluarannya berupa berkas TypeScript, bukan JavaScript siap pakai. Folder hasilnya perlu dikecualikan dari lint, Prettier, coverage, dan versi kontrol.

**4. Memisahkan perangkaian HTTP dari perangkaian dependensi terbayar langsung.** `createAuthHttpApp` menerima dependensi yang sudah jadi, sehingga pengujian memakai aplikasi yang sama persis dengan produksi, hanya dengan repository dalam memori. Aplikasi uji yang dirangkai sendiri akan berbeda dari yang sesungguhnya, dan perbedaannya selalu ada di tempat yang tidak diduga.

**5. Hasher dipalsukan untuk use case, tetapi diuji sungguhan secara terpisah.** Argon2 sengaja lambat; 82 test yang masing-masing menunggu seratus milidetik membuat rangkaian uji tidak layak dijalankan terus-menerus. Adapter aslinya tetap diuji di berkasnya sendiri, karena justru parameter dan opsinya yang menentukan apakah implementasinya aman.

### Yang belum diverifikasi

Docker Desktop tidak berjalan saat step ini dikerjakan, sehingga **belum ada satu pun migrasi Prisma yang dibuat**, dan skema belum pernah benar-benar diterapkan ke PostgreSQL. Adapter Prisma karena itu juga belum pernah dieksekusi terhadap database sungguhan — ia dikecualikan dari coverage dan baru akan teruji pada Step 20.

Yang sudah terbukti: seluruh aturan domain, seluruh use case, seluruh rute HTTP, dan adapter Argon2 serta JWT yang sesungguhnya — 82 test, cakupan 94%.

Jalankan ini setelah Docker menyala:

```bash
pnpm infra:up
cp apps/auth-service/.env.example apps/auth-service/.env
pnpm --filter @tbe/auth-service db:migrate
```

Lalu jalankan service-nya dan cobalah alur daftar → masuk → refresh → keluar dengan `curl` sesuai contoh di README service.

**`/code-review` juga belum dijalankan.** Untuk kode autentikasi, tinjauan keamanan terpisah layak dilakukan sebelum melanjutkan.
