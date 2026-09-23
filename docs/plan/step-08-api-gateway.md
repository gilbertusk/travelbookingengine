# Step 08 — api-gateway

**Fase 1** · Milestone 2 · Estimasi 4 jam · Prasyarat: Step 07

## Tujuan

Satu pintu masuk untuk seluruh trafik klien. Keputusan arsitektur yang ditegakkan di sini: frontend tidak pernah berbicara langsung ke service mana pun.

## Prompt

```
Buat apps/api-gateway, satu-satunya pintu masuk publik untuk seluruh trafik klien.

Baca docs/plan/CONVENTIONS.md terlebih dahulu.

Tanggung jawab gateway, dan hanya ini:

1. Perutean ke service hulu
   - Daftar rute dideklarasikan sebagai data, bukan tersebar di kode
   - Setiap rute menyatakan: path publik, service tujuan, apakah butuh autentikasi,
     dan batas laju yang berlaku
   - Gateway TIDAK boleh memuat logika bisnis apa pun

2. Autentikasi
   - Memverifikasi access token, menolak yang tidak sah sebelum diteruskan
   - Meneruskan identitas pengguna ke hulu lewat header internal tepercaya
   - Membersihkan header identitas yang datang dari klien, supaya tidak bisa dipalsukan

3. Pembatasan laju
   - Berbasis Redis lewat rate-limiter-flexible
   - Batas berbeda untuk rute publik, rute terautentikasi, dan rute pencarian
   - Header standar RateLimit dikembalikan ke klien

4. Perambatan lintas potong
   - correlationId dibuat di sini bila klien tidak mengirimkannya
   - Konteks trace diteruskan ke hulu

5. Penanganan galat dan batas waktu
   - Batas waktu per rute, dengan nilai berbeda untuk pencarian dan sisanya
   - Service hulu yang tidak dapat dihubungi menghasilkan 503 dengan pesan
     yang aman, tanpa membocorkan nama host internal
   - Bentuk respons galat sama untuk semua rute

6. Dukungan Server-Sent Events
   - Rute SSE diteruskan tanpa buffering, dengan batas waktu yang lebih panjang
   - Ini dibutuhkan untuk pemantauan status pemesanan di Step 21

7. Keamanan
   - Helmet, CORS dengan daftar asal yang eksplisit dari env
   - Batas ukuran body
   - Menolak metode HTTP yang tidak dipakai

Buat juga:
- Health check yang melaporkan keterjangkauan seluruh service hulu
- apps/api-gateway/README.md berisi tabel seluruh rute publik,
  kebutuhan autentikasinya, dan batas lajunya
- .env.example

Tulis test untuk: header identitas palsu dari klien dibuang, rute terautentikasi
menolak tanpa token, batas laju menolak setelah ambang, service hulu mati
menghasilkan 503 yang aman, dan SSE tidak ter-buffer.

Commit: feat: add api gateway
```

## Definisi Selesai

- [ ] Seluruh rute dideklarasikan sebagai data di satu tempat
- [ ] Header identitas yang dikirim klien dibuang — dibuktikan dengan test
- [ ] Pembatasan laju bekerja lintas instance karena berbasis Redis
- [ ] Service hulu mati menghasilkan 503 tanpa membocorkan detail internal
- [ ] SSE mengalir tanpa buffering
- [ ] Gateway tidak memuat satu pun aturan bisnis
- [ ] README memuat tabel rute yang lengkap
- [ ] Commit terbuat

## Catatan

Membuang header identitas yang datang dari klien adalah pencegahan celah eskalasi hak akses yang sering terlewat pada arsitektur gateway. Tulis test-nya, dan sebut di ADR.
