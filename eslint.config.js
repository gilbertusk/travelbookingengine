import { node } from '@tbe/eslint-config/node'
import { react19 } from '@tbe/eslint-config/react'

/**
 * Dua kumpulan aturan hidup berdampingan di repo ini: lapisan heksagonal untuk
 * service backend, dan lapisan frontend untuk apps/web. Keduanya memakai pola
 * `apps/*` di paket konfigurasinya masing-masing, jadi di sinilah — satu-satunya
 * tempat yang tahu nama aplikasinya — cakupannya dipersempit.
 *
 * Tanpa pemisahan ini, aturan Next.js akan berjalan pada kode Express, dan
 * aturan arah ketergantungan heksagonal akan berjalan pada komponen React.
 * Keduanya menghasilkan galat yang tidak berarti apa-apa, dan galat yang tidak
 * berarti adalah cara tercepat membuat orang berhenti membaca keluaran linter.
 */

const WEB_GLOB = 'apps/web/**'

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
  ...node.map(exceptWeb),
  ...react19.map(onlyWeb),

  /**
   * Skenario k6.
   *
   * k6 bukan Node: ia menyuntikkan `__VU`, `__ITER`, dan `__ENV` sebagai
   * global, dan mengimpor modul bawaannya lewat penentu `k6/*` yang tidak
   * dapat diselesaikan penyelesai Node mana pun. Dideklarasikan di sini
   * alih-alih dibungkam satu per satu dengan komentar — tiga global yang
   * dipakai di empat berkas akan menjadi selusin komentar yang tidak
   * menjelaskan apa-apa.
   *
   * Aturannya sengaja TIDAK dilonggarkan lebih jauh. Skenario uji beban
   * adalah kode yang hasilnya dikutip sebagai bukti, dan kode seperti itu
   * layak dijaga sama ketatnya dengan kode yang dijalankan pengguna.
   */
  {
    files: ['infra/k6/**/*.{js,mjs}'],
    languageOptions: {
      globals: { __VU: 'readonly', __ITER: 'readonly', __ENV: 'readonly' },
    },
  },
]

/**
 * Hanya blok yang menyasar lapisan di dalam sebuah aplikasi yang perlu
 * menghindari apps/web. Blok umum — aturan dasar TypeScript, pelonggaran untuk
 * berkas uji — tetap berlaku di seluruh repo, termasuk di frontend.
 */
function exceptWeb(config) {
  if (config.files === undefined) return config
  if (!config.files.some((pattern) => pattern.startsWith('apps/*/'))) return config

  return { ...config, ignores: [...(config.ignores ?? []), WEB_GLOB] }
}

function onlyWeb(config) {
  if (config.files === undefined) return config

  return { ...config, files: config.files.map(scopeToWeb) }
}

function scopeToWeb(pattern) {
  if (pattern.startsWith('apps/*/')) return pattern.replace('apps/*/', 'apps/web/')

  return `apps/web/**/${pattern.replace(/^\*\*\//, '')}`
}
