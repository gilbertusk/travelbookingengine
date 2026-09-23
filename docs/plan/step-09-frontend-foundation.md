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

- [ ] Seluruh token desain terdefinisi dan dipakai lewat kelas semantik
- [ ] Tidak ada satu pun nilai warna mentah di komponen
- [ ] Rute `/design-system` menampilkan seluruh token dan primitif
- [ ] Dark mode bekerja lewat redefinisi token, bukan kelas `dark:` berisi warna
- [ ] Empat komponen keadaan tersedia dan dipakai
- [ ] Tidak ada `fetch` langsung di komponen
- [ ] Masuk dan daftar berfungsi melalui gateway
- [ ] Seluruh halaman dapat dioperasikan penuh dengan keyboard, fokus terlihat jelas
- [ ] Tampilan benar pada lebar 375px
- [ ] Seluruh butir DESIGN-SYSTEM.md bagian 11 tercentang
- [ ] Commit terbuat

## Catatan

Satu keputusan yang paling menentukan apakah tampilan terlihat seperti template: serif pada judul. Pastikan benar-benar diterapkan dan hanya pada judul. Kalau seluruh halaman memakai Inter, hasilnya akan terlihat seperti ribuan dashboard lain.
