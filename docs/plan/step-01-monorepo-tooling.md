# Step 01 — Monorepo dan tooling

**Fase 0** · Milestone 1 · Estimasi 3 jam · Prasyarat: tidak ada

## Tujuan

Menyiapkan kerangka monorepo beserta seluruh perkakas kualitas kode, sebelum satu baris logika pun ditulis. Perkakas yang dipasang belakangan hampir selalu berakhir tidak dipakai.

## Prompt

```
Siapkan kerangka monorepo untuk project Travel Booking Engine.

Baca dulu docs/plan/CONVENTIONS.md dan ikuti seluruh aturannya.

Yang dibuat:

1. Inisialisasi git dan pnpm workspace
   - pnpm-workspace.yaml mencakup apps/* dan packages/*
   - .gitignore untuk Node, Next.js, Prisma, Docker, dan file env
   - .nvmrc berisi versi Node 24

2. Turborepo
   - turbo.json dengan task: build, dev, lint, typecheck, test, test:integration
   - Atur dependsOn dan outputs dengan benar supaya cache bekerja

3. TypeScript
   - packages/tsconfig dengan base.json, node.json, react.json
   - strict true, noUncheckedIndexedAccess true, exactOptionalPropertyTypes true
   - Target ES2023, module NodeNext untuk service

4. Linting dan formatting
   - ESLint flat config di packages/eslint-config
   - Aktifkan @typescript-eslint dengan aturan type-aware
   - Larang secara eksplisit: no-explicit-any sebagai error, no-console sebagai error,
     no-floating-promises, require-await, consistent-type-imports
   - Tambahkan aturan import boundary yang melarang domain/ mengimpor dari
     infrastructure/, http/, atau messaging/ (pakai eslint-plugin-boundaries)
   - Prettier tanpa titik koma, single quote, print width 100

5. Git hooks
   - Husky dan lint-staged
   - pre-commit: lint dan format pada file yang diubah
   - commit-msg: commitlint dengan konvensi conventional commits

6. Struktur folder kosong beserta .gitkeep
   - apps/ dan packages/
   - docs/adr/
   - infra/

7. README.md di root berisi: satu paragraf penjelasan project, prasyarat,
   dan cara menjalankan. Belum perlu rinci, akan dilengkapi di Step 29.

Jangan membuat service apa pun di step ini. Hanya kerangka dan perkakas.

Setelah selesai, jalankan pnpm lint dan pnpm typecheck untuk memastikan bersih,
lalu commit dengan pesan: chore: setup monorepo and tooling
```

## Definisi Selesai

- [ ] `pnpm install` berjalan tanpa galat
- [ ] `pnpm lint` dan `pnpm typecheck` bersih
- [ ] Commit dengan pesan tidak sesuai konvensi ditolak oleh commitlint
- [ ] Aturan import boundary aktif dan dapat dibuktikan dengan satu file uji yang sengaja melanggar
- [ ] Turborepo cache bekerja (jalankan `pnpm build` dua kali, yang kedua memakai cache)
- [ ] Commit `chore: setup monorepo and tooling` terbuat

## Catatan

Aturan `eslint-plugin-boundaries` adalah investasi terpenting di step ini. Tanpa penegakan otomatis, pemisahan layer akan bocor pada minggu ketiga dan tidak akan pernah diperbaiki.
