# @tbe/ui

Token desain dan primitif antarmuka yang dipakai bersama `apps/web` dan
`apps/ops` (Step 27, keputusan Q6). Dipindahkan dari `apps/web/src/components/ui`
tanpa mengubah perilakunya.

## Kenapa paket sumber, tanpa langkah build

`exports` menunjuk langsung ke berkas `.tsx`, dan kedua aplikasi Next memasang
`transpilePackages: ['@tbe/ui']`. Alternatif yang ditolak: membangun paket ke
`dist/` dengan tsc atau tsup. Itu menambah satu tahap build dan satu tempat
peta sumber bisa salah, untuk paket yang hanya dipakai dua aplikasi Next di
monorepo yang sama.

## Pemakaian

```ts
import { Button } from '@tbe/ui/button'
import { cn } from '@tbe/ui/cn'
```

```css
@import 'tailwindcss';
@import '@tbe/ui/tokens.css';
@source '<jalur relatif ke>/packages/ui/src';
```

Tanpa `@source`, Tailwind tidak memindai paket ini dan kelas yang hanya muncul
di sini tidak pernah dibangkitkan.

## Aturan

- `src/styles/tokens.css` adalah SATU-SATUNYA berkas frontend yang boleh memuat
  nilai warna. `pnpm verify:tokens` memeriksa paket ini, `apps/web`, dan
  `apps/ops`; `pnpm verify:contrast` mengukur kontras dari berkas ini.
- Primitif adalah salinan shadcn/Radix. Perilakunya milik Radix; yang kita ubah
  hanya kelasnya. Karena itu paket ini tidak punya uji sendiri — komponen yang
  memakainya diuji di aplikasi masing-masing.
