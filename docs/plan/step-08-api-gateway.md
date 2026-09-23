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

- [x] Seluruh rute dideklarasikan sebagai data di satu tempat
- [x] Header identitas yang dikirim klien dibuang — dibuktikan dengan test
- [ ] Pembatasan laju bekerja lintas instance karena berbasis Redis — **belum diverifikasi**, lihat Catatan
- [x] Service hulu mati menghasilkan 503 tanpa membocorkan detail internal
- [x] SSE mengalir tanpa buffering
- [x] Gateway tidak memuat satu pun aturan bisnis
- [x] README memuat tabel rute yang lengkap
- [x] Commit terbuat

## Catatan

Membuang header identitas yang datang dari klien adalah pencegahan celah eskalasi hak akses yang sering terlewat pada arsitektur gateway. Tulis test-nya, dan sebut di ADR.

### Temuan saat mengerjakan step ini

**1. Membuang header palsu berdasarkan awalan, bukan daftar nama.** Menyebut `x-tbe-user-id` dan `x-tbe-user-email` satu per satu berarti setiap header internal yang ditambahkan nanti menjadi celah sampai seseorang ingat memperbarui daftarnya. Yang dibuang adalah seluruh header berawalan `x-tbe-`, dan ada test yang mengirim nama yang sengaja belum ada.

**2. Urutan di `outboundHeaders` adalah keamanannya.** Header palsu dibuang LEBIH DULU, identitas hasil verifikasi ditambahkan SESUDAHNYA. Urutan terbalik akan ikut menghapus identitas yang baru saja dipasang — dan gejalanya bukan galat, melainkan service hulu yang tiba-tiba menerima permintaan tanpa identitas sama sekali.

**3. Pencocokan rute memakai awalan terpanjang, bukan urutan daftar.** Bergantung pada urutan berarti menyisipkan satu rute baru di posisi yang salah diam-diam mengubah perilaku rute lain. Pencocokan juga harus berhenti pada batas segmen: tanpa itu `/searching-for-trouble` cocok dengan awalan `/search`.

**4. Gateway tidak boleh mengurai badan permintaan.** `express.json()` menghabiskan aliran, dan aliran yang sudah habis tidak dapat diteruskan. Ini memaksa penambahan opsi `bodyParser: 'none'` pada factory server di shared-kernel — satu-satunya perubahan pada paket bersama yang dibutuhkan step ini.

**5. Batas laju dihitung setelah identitas diverifikasi.** Kalau terbalik, seluruh pengguna di balik satu NAT kantor berbagi satu kuota. Health dan metrik sengaja didaftarkan sebelum pembatas laju, supaya pemantauan tetap terbaca justru saat sistem sedang membatasi lajunya.

**6. Batas waktu dan "tidak dapat dihubungi" dibedakan, bukan disatukan.** Pada batas waktu, hulu mungkin sudah mengerjakan permintaannya; pada koneksi yang ditolak, pasti belum. Perbedaan itu yang menentukan apakah aman mencoba lagi, dan menyatukan keduanya menjadi "gagal" menghilangkan informasinya untuk selamanya.

**7. Kedua adapter infrastruktur diuji sungguhan, bukan ditiru.** Klien hulu diuji terhadap server `node:http` yang benar-benar dijalankan pada port sementara — termasuk server yang sengaja lambat untuk membuktikan pemetaan batas waktu, dan port yang sudah ditutup untuk membuktikan pemetaan `unreachable`. Verifier diuji dengan token yang benar-benar ditandatangani, termasuk token `alg=none` yang dirakit tangan: serangan klasik yang hanya tertutup karena daftar algoritma ditulis eksplisit.

**8. Kegagalan penyimpanan batas laju harus diteruskan, bukan dianggap kuota habis.** `rate-limiter-flexible` melempar objek hasil ketika kuota habis — nilai yang dilempar itu jawabannya, bukan galat. Tetapi galat sungguhan (Redis terputus) juga datang lewat `catch` yang sama. Menganggap keduanya sama membuat seluruh lalu lintas ditolak 429 saat Redis tumbang, dan menyembunyikan penyebabnya dari siapa pun yang membaca log.

### Yang belum diverifikasi

Docker Desktop masih tidak berjalan, sehingga **pembatas laju berbasis Redis belum pernah dijalankan terhadap Redis yang menyala**. Yang sudah terbukti: kedua implementasi memenuhi port yang sama, keempat kelas kebijakan benar-benar dibangun pada varian Redis, dan seluruh perilaku menolak/mengizinkan diuji lewat varian dalam memori.

Yang belum terbukti hanyalah klaim yang justru menjadi alasan memakai Redis: bahwa kuota dihitung bersama lintas replika.

Jalankan ini setelah Docker menyala:

```bash
pnpm infra:up
cp apps/api-gateway/.env.example apps/api-gateway/.env
pnpm --filter @tbe/api-gateway dev
```

Lalu buktikan penghitungan bersama dengan menjalankan dua instance pada port berbeda dan menembak keduanya bergantian — kuota harus habis setelah 10 permintaan total, bukan 10 per instance:

```bash
for i in $(seq 1 12); do
  curl -s -o /dev/null -w "%{http_code} " -X POST localhost:4001/auth/login     -H 'content-type: application/json' -d '{"email":"a@b.com","password":"x"}'
done
```

**`/code-review` belum dijalankan** untuk step ini maupun Step 07.
