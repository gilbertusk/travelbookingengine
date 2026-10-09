# web

Aplikasi pengguna: mencari, membandingkan, dan memesan penginapan. Next.js App Router, Server Component sebagai bawaan.

Seluruh trafik lewat api-gateway. Aplikasi ini tidak pernah berbicara langsung ke service mana pun.

## Menjalankan

```bash
cp apps/web/.env.example apps/web/.env.local
pnpm --filter @tbe/web dev
```

Beranda, sistem desain, masuk, dan daftar dapat dibuka tanpa backend menyala. Masuk dan daftar membutuhkan api-gateway dan auth-service berjalan.

## Halaman

| Rute                | Akses  | Isi                                                                  |
| ------------------- | ------ | -------------------------------------------------------------------- |
| `/`                 | Publik | Hero dan batang pencarian                                            |
| `/cari`             | Publik | Hasil pencarian — penampung, diisi Step 14                           |
| `/masuk`            | Tamu   | Formulir masuk                                                       |
| `/daftar`           | Tamu   | Formulir pendaftaran                                                 |
| `/bookings`         | Privat | Daftar pemesanan — penampung, diisi Step 26                          |
| `/bookings/pesan`   | Privat | Alur pemesanan: data tamu, harga berubah, hold, pembayaran (Step 21) |
| `/bookings/[id]`    | Privat | Status langsung (SSE) dan konfirmasi pemesanan (Step 21)             |
| `/bookings/kembali` | Privat | Finish URL Snap halaman penuh; meneruskan ke status pemesanan        |
| `/design-system`    | Publik | Acuan seluruh token dan primitif                                     |

Rute privat dijaga [`src/proxy.ts`](src/proxy.ts). Yang diperiksa hanya keberadaan cookie sesi, bukan keabsahannya — keputusan akses yang sebenarnya tetap di gateway, yang memang memverifikasi setiap permintaan. Memverifikasi tanda tangan token di sini berarti menaruh rahasia penandatanganan di tempat ketiga tanpa menambah keamanan.

## Sesi

Dua token, dua tempat penyimpanan yang berbeda, dan pembagiannya disengaja:

| Token         | Disimpan di                       | Dapat dibaca JavaScript? |
| ------------- | --------------------------------- | ------------------------ |
| Access token  | Memori halaman                    | Ya, oleh kode kita saja  |
| Refresh token | Cookie `httpOnly`, `SameSite=Lax` | Tidak                    |

Tidak ada satu pun token di `localStorage`. Token yang dapat dibaca `localStorage` juga dapat dibaca skrip pihak ketiga mana pun yang berhasil masuk ke halaman, dan satu kebocoran berarti token itu dapat dipakai sampai kedaluwarsa tanpa jejak.

Konsekuensinya: access token hilang setiap kali halaman dimuat ulang. Itu dipulihkan dengan satu panggilan ke `/api/auth/refresh`, yang memegang cookie dan menukarnya di gateway.

Rute Next di `src/app/api/auth/*` ada semata-mata untuk ini — hanya server yang boleh menyentuh refresh token. Sisanya memanggil gateway langsung lewat [`src/lib/api-client.ts`](src/lib/api-client.ts).

`/auth/refresh` membalas `200` dengan `accessToken: null` ketika tidak ada cookie sama sekali. Pengunjung yang memang belum pernah masuk bukan permintaan yang ditolak, dan membalas `401` di sana menaruh satu galat merah di konsol setiap orang yang membuka beranda.

## Struktur

```
src/
├── app/              Rute Next dan rute API BFF
├── components/
│   ├── ui/           Primitif shadcn, disesuaikan token
│   ├── layout/       Header, footer, menu akun
│   ├── state/        Empat keadaan wajib
│   └── <fitur>/      Komponen spesifik fitur
├── features/<fitur>/ Hook, query, tipe, dan panggilan jaringan fitur
├── lib/              Utilitas lintas fitur
└── styles/           globals.css — satu-satunya berkas yang memuat nilai warna
```

Arah ketergantungan ditegakkan `eslint-plugin-boundaries`:

```
app ──> components ──> ui ──┐
         │                  ├──> lib
         └──> features ─────┘
```

Dua hal yang dijaga aturan itu: `features/` tidak boleh mengimpor komponen — logika fitur yang menarik JSX ikut terseret setiap kali tampilannya berubah — dan `components/ui/` tidak boleh tahu apa pun tentang fitur, karena begitu ia tahu, ia bukan primitif lagi.

Tidak ada komponen yang memanggil `fetch` sendiri. Semua lewat `features/<fitur>/api.ts`.

## Sistem desain

Kontraknya ada di [docs/plan/DESIGN-SYSTEM.md](../../docs/plan/DESIGN-SYSTEM.md); penerapannya ada di [`src/styles/globals.css`](src/styles/globals.css) dan terlihat seluruhnya di `/design-system`.

Dua aturan ditegakkan naskah, bukan kesepakatan:

```bash
pnpm verify:tokens     # tidak ada warna mentah, tidak ada jarak di luar skala 4px
pnpm verify:contrast   # 30 pasangan warna, keduanya tema, terhadap WCAG AA
```

Keduanya menangkap hal yang tidak dapat ditangkap tipe maupun linter biasa. `bg-[#0ea5e9]` tetap dikompilasi dengan benar dan terlihat benar di tampilan terang; ia baru salah di tampilan gelap, di mesin orang lain.

Dark mode bekerja lewat **redefinisi token**, bukan kelas `dark:` berisi warna. Tidak ada satu pun kelas seperti itu di seluruh aplikasi, dan `verify:tokens` menolaknya.

## Aksesibilitas

Dicek di setiap step frontend, bukan di akhir:

- Setiap input punya `<label>` yang tertaut, bukan placeholder yang menyamar sebagai label
- Pesan galat tertaut lewat `aria-describedby` dan diumumkan `aria-live` — lihat [`src/components/auth/field.tsx`](src/components/auth/field.tsx)
- Tautan "Lompat ke konten" di awal header
- Target sentuh 44px pada perangkat sentuh; tombol kecil hanya mengecil pada penunjuk presisi
- `prefers-reduced-motion` mematikan seluruh gerak posisi, menyisakan opasitas
- Kontras AA di kedua tema, diukur bukan dikira — `pnpm verify:contrast`

## Pengujian

```bash
pnpm --filter @tbe/web test
```

90 test. Yang diuji adalah lapisan data dan perilaku: penanganan 401, kebijakan percobaan ulang, atribut cookie sesi, penjagaan rute, dan aksesibilitas formulir. Primitif salinan shadcn tidak diuji — perilakunya milik Radix dan sudah diuji di sana; yang kita ubah hanya kelas CSS-nya.
