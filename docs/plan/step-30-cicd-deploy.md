# Step 30 — CI/CD dan deployment

**Fase 5** · Milestone 6 · Estimasi 7 jam · Prasyarat: Step 29 · Q7 sudah dijawab: aktif selama masa melamar

## Tujuan

Memenuhi M12: sistem dapat dilihat tanpa instalasi. Ini syarat terakhir Definisi Selesai pada PRD Bab 16.

## Prompt

```
Siapkan CI/CD dan deploy sistem ke lingkungan yang dapat diakses publik.

Baca terlebih dahulu PRD M12, Bab 5.3, keputusan Q7, dan Bab 16.

=== CI dengan GitHub Actions ===

1. Alur pull request
   - Lint, typecheck, uji unit, build, dijalankan paralel per workspace
   - Turborepo cache dimanfaatkan supaya cepat
   - Uji integrasi dengan Testcontainers, dijalankan terpisah karena lebih lambat
   - Laporan cakupan, gagal bila di bawah 80%
   - Pemindaian kerentanan dependensi
   - Pemindaian rahasia yang bocor di riwayat commit

2. Alur main
   - Seluruh pemeriksaan pull request
   - Build image Docker per service, multi-stage, non-root user,
     ukuran ditekan
   - Push ke registry
   - Deploy otomatis

3. Alur berkala
   - Uji beban k6 dijalankan mingguan terhadap lingkungan staging
   - Hasilnya disimpan sebagai artefak, sehingga tren terlihat

=== Deployment ===

4. Backend
   Keputusan Q7: demo berjalan di tingkat gratis selama masa melamar,
   sekitar 3-6 bulan, dan boleh dimatikan setelahnya. Karena itu pilih
   layanan yang tingkat gratisnya memadai dan JANGAN membangun apa pun yang
   menimbulkan biaya berjalan. Catat di README bahwa demo dapat dimatikan
   sewaktu-waktu dan video tetap tersedia.
   - Deploy ke Railway atau Fly.io
   - PostgreSQL dan Redis terkelola
   - Kafka terkelola lewat Upstash atau Confluent Cloud tingkat gratis
   - RabbitMQ terkelola lewat CloudAMQP tingkat gratis
   - Seluruh rahasia lewat pengelola rahasia platform, tidak ada di repo
   - Migrasi Prisma dijalankan otomatis sebelum service dimulai,
     dengan pengunci supaya tidak berjalan ganda saat penggandaan
   - Health check terhubung ke mekanisme platform

5. Frontend
   - apps/web ke Vercel, diakses publik
   - apps/ops ke Vercel sebagai proyek terpisah, TIDAK diakses publik.
     Lindungi dengan perlindungan deployment Vercel atau pembatasan alamat IP.
     Ini konsekuensi keputusan Q6 dan harus benar-benar diterapkan, bukan
     hanya mengandalkan pemeriksaan peran
   - Variabel lingkungan mengarah ke gateway produksi
   - Domain kustom bila ada

6. Data demonstrasi
   - Skrip seed yang mengisi akun uji dan data yang masuk akal
   - Akun uji dicantumkan di README
   - mock-supplier ikut ter-deploy, dan panel kendalinya dilindungi
     tetapi dapat diakses untuk demonstrasi

7. Kesiapan produksi minimum
   - Rate limit aktif di gateway
   - CORS dibatasi ke domain frontend
   - Log terstruktur dapat dilihat di platform
   - Pemantauan sederhana untuk ketersediaan

=== Video demonstrasi ===

8. Rekaman 2 menit, tanpa narasi panjang, menunjukkan:
   - Pencarian normal dengan seluruh supplier sehat
   - Satu supplier dimatikan dari panel kendali, pencarian tetap jalan
     dan pemberitahuan hasil parsial muncul
   - Alur pemesanan sampai konfirmasi
   - Supplier dimatikan di tengah pembayaran, refund otomatis berjalan,
     dan status terlihat langsung di halaman
   - Trace Jaeger dari alur tersebut

   Urutan ini yang paling meyakinkan. Simpan tautannya di README paling atas.

=== Verifikasi akhir ===

9. Periksa seluruh Definisi Selesai pada PRD Bab 16 satu per satu.
   Perbarui status PRD dari DRAFT menjadi DELIVERED bila seluruhnya terpenuhi,
   dan catat bagian mana yang tidak terpenuhi bila ada.

Commit: ci: add pipelines and deployment configuration
```

## Definisi Selesai

- [ ] CI menjalankan lint, typecheck, uji unit, uji integrasi, dan cakupan
- [ ] CI gagal bila cakupan di bawah 80%
- [ ] Pemindaian rahasia berjalan dan bersih
- [ ] Image Docker multi-stage, berjalan sebagai non-root
- [ ] Migrasi dijalankan otomatis dengan pengunci
- [ ] Backend dan frontend dapat diakses publik
- [ ] Tidak ada rahasia di repo
- [ ] Akun uji tersedia dan tercantum di README
- [ ] Panel kendali mock-supplier dapat diakses untuk demonstrasi
- [ ] Video demonstrasi 2 menit direkam dan tertaut di README
- [ ] Seluruh butir PRD Bab 16 diperiksa dan statusnya diperbarui
- [ ] Commit terbuat

## Catatan

Urutan dalam video menentukan segalanya. Mulai dari keadaan normal supaya penonton paham produknya, lalu rusak sesuatu. Kontras itulah isi sebenarnya dari video. Jangan membuka dengan penjelasan arsitektur — tidak ada yang menonton sampai habis.
