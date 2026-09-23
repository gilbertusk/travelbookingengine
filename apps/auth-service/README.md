# auth-service

Pendaftaran, masuk, rotasi sesi, dan profil dasar. Service backend pertama di project ini, dan strukturnya menjadi cetak biru bagi sembilan service berikutnya.

## Menjalankan

```bash
cp apps/auth-service/.env.example apps/auth-service/.env
pnpm infra:up
pnpm --filter @tbe/auth-service db:migrate
pnpm --filter @tbe/auth-service dev
```

## Endpoint

| Metode  | Path                            | Autentikasi | Keterangan                                        |
| ------- | ------------------------------- | ----------- | ------------------------------------------------- |
| `POST`  | `/auth/register`                | —           | Membuat akun, langsung menerbitkan sepasang token |
| `POST`  | `/auth/login`                   | —           | Menukar kredensial dengan sepasang token          |
| `POST`  | `/auth/refresh`                 | —           | Merotasi refresh token                            |
| `POST`  | `/auth/logout`                  | —           | Mencabut seluruh keluarga token                   |
| `GET`   | `/auth/me`                      | Bearer      | Profil pengguna                                   |
| `PATCH` | `/auth/me`                      | Bearer      | Memperbarui nama                                  |
| `GET`   | `/health/live`, `/health/ready` | —           | Liveness dan readiness                            |
| `GET`   | `/metrics`                      | —           | Metrik Prometheus                                 |

Seluruh respons memakai amplop `{ data, error }` dari `@tbe/shared-kernel`.

### Contoh

```bash
curl -X POST localhost:4002/auth/register -H 'content-type: application/json' \
  -d '{"email":"budi@example.com","password":"kataSandiPanjangAman","name":"Budi"}'

curl -X POST localhost:4002/auth/login -H 'content-type: application/json' \
  -d '{"email":"budi@example.com","password":"kataSandiPanjangAman"}'

curl localhost:4002/auth/me -H "authorization: Bearer <accessToken>"
```

## Keputusan keamanan

**Argon2id, bukan bcrypt.** bcrypt memotong kata sandi pada 72 byte dan tidak tahan serangan berbasis memori. Parameter mengikuti profil OWASP: 19 MiB memori, dua iterasi, paralelisme satu.

**Access token pendek, refresh token dapat dicabut.** Access token tidak dapat dihentikan sebelum kedaluwarsa, jadi umurnya 15 menit. Pencabutan sesungguhnya terjadi pada refresh token, yang disimpan sebagai hash dan dapat dimatikan kapan saja.

**Refresh token dirotasi, dan pemakaian ulang mencabut seluruh keluarga.** Setiap kali dipakai, token ditandai terpakai dan penggantinya diterbitkan. Token yang sudah terpakai lalu muncul lagi berarti dua pihak memegangnya, dan satu di antaranya bukan pemiliknya. Karena tidak ada cara membedakan mana yang asli, keduanya dicabut.

Tanpa ini, pencurian refresh token memberi penyerang akses selama umur token dan korban tidak pernah tahu.

**Refresh token disimpan sebagai hash SHA-256, bukan nilai aslinya.** Basis data yang bocor tidak boleh langsung memberi penyerang sesi yang masih hidup. Argon2 justru salah di sini: token punya entropi 256 bit dari sumber acak kriptografis, jadi tidak ada yang bisa ditebak — Argon2 hanya menambah beberapa puluh milidetik pada setiap rotasi.

**Surel tidak terdaftar dan kata sandi salah menghasilkan respons yang identik**, termasuk pesannya. Verifikasi Argon2 tetap dijalankan terhadap hash palsu ketika akun tidak ditemukan, karena melewatinya membuat permintaan untuk surel tak terdaftar kembali jauh lebih cepat — dan selisih waktu itu cukup untuk memetakan siapa saja yang punya akun.

**Pembatas percobaan masuk membatasi per akun, bukan per alamat IP.** Pembatas per-IP ada di gateway (Step 08) dan tidak dapat menggantikan ini: serangan penyemprotan kata sandi memakai ribuan alamat IP dan satu kata sandi, dan pembatas per-IP tidak melihatnya sama sekali.

**Algoritma JWT dibatasi eksplisit ke HS256.** Pustaka yang mempercayai header token itu sendiri akan menerima token bertanda tangan `none` — celah klasik yang diuji di `adapters.test.ts`.

**Tidak ada nilai bawaan untuk `JWT_SECRET`.** Service menolak menyala bila tidak diberikan, atau bila panjangnya kurang dari 32 karakter.

## Struktur

Mengikuti [CONVENTIONS.md](../../docs/plan/CONVENTIONS.md) bagian 1. Arah ketergantungan ditegakkan ESLint, bukan kesepakatan:

```
domain/         Aturan murni: surel, kata sandi, sesi. Tanpa I/O, tanpa framework.
application/    Use case dan port. Tahu domain, tidak tahu Prisma maupun HTTP.
infrastructure/ Argon2, jose, Prisma, jam, pembatas. Mengimplementasi port.
http/           Rute, skema, middleware autentikasi.
composition/    Perangkaian, dipakai bersama oleh index.ts dan pengujian.
testing/        Repository dalam memori. Tidak ikut ter-build.
```

Use case diuji tanpa database sama sekali — repository dalam memori memenuhi port yang sama. Adapter sungguhan (Argon2, JWT) diuji terpisah di `infrastructure/adapters.test.ts`, karena justru parameter dan opsinya yang menentukan apakah implementasinya aman.

## Catatan Prisma 7

Sejak Prisma 7, URL koneksi tidak lagi boleh berada di `schema.prisma`. Migrate membacanya dari `prisma.config.ts`, dan `PrismaClient` menerimanya lewat driver adapter (`@prisma/adapter-pg`). Pemisahan itu berarti kredensial produksi tidak pernah perlu hadir dalam bentuk apa pun di dalam berkas skema.
