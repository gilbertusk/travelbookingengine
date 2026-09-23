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
- [ ] `/code-review` dijalankan dan temuan CRITICAL serta HIGH ditutup
- [ ] Commit terbuat

## Catatan

Pemakaian ulang refresh token yang mencabut seluruh sesi adalah detail kecil yang menunjukkan kamu paham serangan pencurian token. Murah untuk dibuat, mahal nilainya saat ditanya.
