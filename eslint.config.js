import { node } from '@tbe/eslint-config/node'

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/prisma/generated/**',
      // Klien Prisma tergenerate: ribuan baris, sudah membawa ts-nocheck
      // sendiri, dan bukan kode yang kita tulis.
      '**/src/generated/**',
      'apps/__boundary_check__/**',
    ],
  },
  ...node,
]
