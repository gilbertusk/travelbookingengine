# Step 09 — Frontend: fondasi dan design system

**Fase 1** · Milestone 2 · Estimasi 6 jam · Prasyarat: Step 08

## Tujuan

Menegakkan arah visual sejak awal. Design system yang dibuat setelah lima halaman jadi tidak akan pernah diterapkan mundur — halaman lama akan dibiarkan berbeda, dan keseluruhannya terlihat tidak disengaja.

## Prompt

```
Buat apps/web, aplikasi Next.js untuk pengguna, beserta fondasi design system-nya.

Baca docs/plan/DESIGN-SYSTEM.md dan docs/plan/CONVENTIONS.md bagian 13 terlebih
dahulu. Dokumen desain itu adalah kontrak, bukan saran — terutama bagian
"Yang dihindari karena membuat tampilan terasa generik".

1. Inisialisasi
   - Next.js 15 App Router, TypeScript, Tailwind
   - Struktur folder sesuai CONVENTIONS.md bagian 13
   - Server Component sebagai bawaan

2. Token desain
   - Terjemahkan seluruh token warna, tipografi, jarak, radius, dan bayangan dari
     DESIGN-SYSTEM.md ke CSS custom property di globals.css
   - Petakan ke konfigurasi Tailwind sehingga dipakai lewat kelas semantik
     seperti bg-background, text-muted-foreground — bukan nilai mentah
   - Definisikan ulang token untuk dark mode. Jangan menulis kelas dark: berisi
     warna mentah di komponen mana pun
   - Muat Inter dan Instrument Serif lewat next/font dengan subset yang tepat

3. Primitif shadcn/ui
   - Pasang dan sesuaikan: Button, Input, Label, Card, Dialog, Sheet, Popover,
     Calendar, Select, Badge, Skeleton, Separator, Sonner, Tabs, Alert
   - Sesuaikan agar memakai token, radius, dan bayangan sesuai dokumen desain
   - Button hanya punya varian: primary, secondary, ghost, destructive.
     Jangan menambah varian lain

4. Kerangka tata letak
   - Header dengan logo wordmark sederhana, navigasi, dan menu akun
   - Footer ringkas
   - Lebar konten maksimum sesuai dokumen desain
   - Halaman galat dan halaman tidak ditemukan yang dirancang, bukan bawaan Next.js

5. Komponen keadaan
   - Buat komponen generik untuk empat keadaan wajib: LoadingState, EmptyState,
     ErrorState, dan pembungkus yang memilih salah satunya
   - EmptyState dan ErrorState menerima judul, penjelasan, dan satu aksi

6. Lapisan akses data
   - lib/api-client.ts: pembungkus fetch yang menambahkan base URL gateway,
     menyisipkan token, menangani 401 dengan refresh sekali, dan mengubah
     galat menjadi bentuk tipe yang konsisten
   - Konfigurasi TanStack Query dengan nilai bawaan yang masuk akal
   - Tidak ada satu pun komponen yang memanggil fetch langsung

7. Autentikasi
   - Halaman masuk dan daftar, memakai komponen yang sudah dibuat
   - Penyimpanan token yang aman, dan middleware yang melindungi rute privat
   - Formulir memakai React Hook Form dan Zod

8. Halaman beranda
   - Hero dengan SearchBar sebagai elemen utama — ini akan diisi di Step 14,
     untuk sekarang buat kerangkanya yang sudah benar secara visual
   - Satu bagian pendukung, tidak lebih. Jangan membuat halaman pemasaran panjang

9. Halaman contoh design system
   - Rute /design-system yang menampilkan seluruh token, skala tipografi,
     dan seluruh primitif dalam setiap variannya
   - Halaman ini untukmu sendiri sebagai acuan, dan berguna saat menunjukkan
     kedisiplinan sistem desain ke penilai

Aksesibilitas wajib sejak sekarang, sesuai DESIGN-SYSTEM.md bagian 9.

Sebelum menutup step, periksa seluruh butir pada DESIGN-SYSTEM.md bagian 11.

Commit: feat: add web app foundation and design system
```

## Definisi Selesai

- [x] Seluruh token desain terdefinisi dan dipakai lewat kelas semantik
- [x] Tidak ada satu pun nilai warna mentah di komponen — dibuktikan `pnpm verify:tokens`
- [x] Rute `/design-system` menampilkan seluruh token dan primitif
- [x] Dark mode bekerja lewat redefinisi token, bukan kelas `dark:` berisi warna
- [x] Empat komponen keadaan tersedia dan dipakai
- [x] Tidak ada `fetch` langsung di komponen
- [ ] Masuk dan daftar berfungsi melalui gateway — **belum diverifikasi ujung ke ujung**, lihat Catatan
- [x] Seluruh halaman dapat dioperasikan penuh dengan keyboard, fokus terlihat jelas
- [x] Tampilan benar pada lebar 375px
- [x] Seluruh butir DESIGN-SYSTEM.md bagian 11 tercentang
- [x] Commit terbuat

## Catatan

Satu keputusan yang paling menentukan apakah tampilan terlihat seperti template: serif pada judul. Pastikan benar-benar diterapkan dan hanya pada judul. Kalau seluruh halaman memakai Inter, hasilnya akan terlihat seperti ribuan dashboard lain.

### Temuan saat mengerjakan step ini

**1. Next 16 dan Tailwind 4, bukan Next 15.** Rencana menyebut Next 15; yang stabil saat step ini dikerjakan adalah 16. App Router-nya sama, tetapi dua hal berubah: konvensi `middleware.ts` berganti nama menjadi `proxy.ts` (nama lama masih bekerja tetapi sudah usang), dan Tailwind 4 tidak lagi memakai `tailwind.config.js` sama sekali — token didefinisikan langsung di CSS lewat `@theme`. Yang kedua justru sejalan dengan dokumen desain: tidak ada lagi dua tempat yang menyimpan nilai warna.

**2. TypeScript 7 menghapus `baseUrl`.** Alias path sekarang relatif terhadap letak `tsconfig.json`. Galatnya jelas, tetapi hanya muncul saat `tsc` dijalankan — `next dev` berjalan tanpa keluhan.

**3. Memuat `base` dua kali merusak seluruh konfigurasi lint backend.** Konfigurasi React awalnya menyertakan `base` seperti konfigurasi node, dan karena konfigurasi flat ESLint dimenangkan blok terakhir, salinan kedua menimpa blok pelonggaran untuk berkas uji — 236 galat mendadak muncul pada berkas uji backend yang sebelumnya bersih. Aturan lapisan frontend sekarang tidak memuat `base`, dan hanya blok yang menyasar `apps/*` yang dipersempit cakupannya.

**4. Komentar blok yang memuat `*/` menutup dirinya sendiri.** Menulis pola glob `apps/*/src/...` di dalam komentar `/** */` menghasilkan `SyntaxError: Unexpected token '...'` yang tidak menyebut komentar sama sekali.

**5. Pemeriksa token menemukan enam pelanggaran buatan sendiri.** `px-2.5`, `py-0.5`, `gap-1.5`, `py-1.5` — seluruhnya di luar skala 4px, seluruhnya ditulis tanpa sadar. Ini alasan aturan yang tidak ditegakkan perkakas selalu bocor: yang menulisnya adalah orang yang sama yang menulis aturannya.

**6. Kontras harus diukur, bukan dilihat.** Empat pasangan warna gagal AA meski terlihat baik-baik saja di layar: hijau `success` sebagai teks di tampilan terang (3.92:1), teks putih di atas tombol merusak pada tampilan gelap (3.38:1), dan badge `primary` serta `success` yang latar tipisnya sendiri menurunkan kontras di bawah 4.5. Yang terakhir paling halus — warnanya benar, latarnya benar, hanya campuran keduanya yang salah.

**7. Badge `warning` tidak terbaca sama sekali di tampilan gelap.** Ia memakai `text-warning-foreground` yang gelap di atas latar kuning tipis yang juga gelap — 1.13:1. Kuning adalah satu-satunya warna semantik yang tidak punya bentuk teks yang lulus AA di kedua tema, jadi badge itu sekarang memakai teks netral.

**8. Ketidakcocokan hidrasi pada pengalih tema.** Penjaga "sudah terhidrasi" awalnya hanya melindungi ikon, bukan `aria-label`-nya — dan React tidak memperbaiki atribut yang berbeda, sehingga yang tertinggal adalah nama tombol yang salah bagi pengguna pembaca layar. Keadaan hidrasi juga dibaca lewat `useSyncExternalStore`, bukan `useState` di dalam `useEffect`, supaya tidak ada render berantai.

**9. Pengujian bocor lewat `localStorage`.** next-themes menyimpan pilihan tema di sana, dan `cleanup()` tidak membersihkannya. Satu pengujian yang mengganti tema membuat pengujian berikutnya mulai dari tema yang salah, lalu gagal karena alasan yang tidak terlihat sama sekali dari isinya.

**10. Satu galat merah di konsol untuk setiap pengunjung anonim.** Rute refresh membalas 401 ketika tidak ada cookie. Secara teknis benar, secara praktik merusak: galat yang selalu ada adalah galat yang berhenti dibaca. Sekarang membalas 200 dengan `accessToken: null`; 401 disimpan untuk cookie yang benar-benar ditolak gateway.

**11. Dua tombol aksen di satu layar.** "Daftar" di header dan "Cari" di hero sama-sama memakai aksen. Aksen di header menetap di setiap halaman dan karena itu selalu bersaing dengan aksi sesungguhnya — sekarang sekunder.

### Yang belum diverifikasi

**Alur masuk dan daftar belum dijalankan ujung ke ujung.** Docker masih mati, jadi auth-service dan gateway belum pernah menyala bersama aplikasi ini. Yang sudah terbukti: bentuk permintaan, penanganan 401 dengan refresh sekali, penulisan cookie beserta seluruh atributnya, penjagaan rute, dan tampilan galat — seluruhnya lewat 90 test dengan jaringan yang dipalsukan pada batas `fetch`.

Yang belum terbukti adalah kecocokan bentuk respons auth-service yang sungguhan dengan yang diasumsikan di sini.

Jalankan ini setelah Docker menyala:

```bash
pnpm infra:up
pnpm --filter @tbe/auth-service db:migrate
pnpm --filter @tbe/auth-service dev
pnpm --filter @tbe/api-gateway dev
pnpm --filter @tbe/web dev
```

Lalu daftar lewat `/daftar`, muat ulang halaman untuk membuktikan sesi pulih dari cookie, dan buka `/bookings` setelah keluar untuk membuktikan pengalihan bekerja.

**Pemeriksaan visual sebagian dilakukan lewat DOM, bukan tangkapan layar.** Panel peramban tersembunyi selama sebagian sesi, yang menghentikan pipeline render — tangkapan layar gagal dan pengukuran gaya per-elemen menjadi tidak konsisten. Beranda pada 375px dan 1280px sempat terlihat langsung dan benar; sisanya diperiksa lewat struktur DOM dan naskah kontras, yang justru dapat diulang kapan saja.
