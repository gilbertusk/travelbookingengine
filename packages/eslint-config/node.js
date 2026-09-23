import boundaries from 'eslint-plugin-boundaries'
import { base } from './base.js'

/**
 * Penegakan arah ketergantungan antar layer pada service backend.
 * Lihat docs/plan/CONVENTIONS.md bagian 1.
 *
 *   http ──┐
 *          ├──> application ──> domain
 *   messaging ──┘                  ▲
 *                                  │
 *   infrastructure ────────────────┘ (hanya mengimplementasi port)
 *
 * domain/ tidak boleh mengimpor apa pun dari lapisan luar. Aturan ini ada di
 * sini, bukan di dokumen saja, karena kesepakatan yang tidak ditegakkan
 * perkakas selalu bocor sebelum bulan kedua.
 */
export const node = [
  ...base,
  {
    files: ['apps/*/src/**/*.ts'],
    plugins: { boundaries },
    settings: {
      // Tanpa resolver TypeScript, impor gaya NodeNext seperti
      // '../infrastructure/thing.js' tidak dapat dipetakan ke berkas .ts,
      // dependensinya dianggap bertipe tidak dikenal, dan aturan boundary
      // lolos begitu saja tanpa galat.
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: ['apps/*/tsconfig.json', 'packages/*/tsconfig.json'],
        },
      },

      // Mode bawaan plugin adalah 'folder': pola mencocokkan folder elemen,
      // dan seluruh berkas di dalamnya mewarisi tipe itu. Menulis pola yang
      // mencocokkan berkas justru membuat semuanya bertipe tidak dikenal dan
      // aturannya diam-diam tidak pernah berjalan.
      'boundaries/elements': [
        { type: 'domain', pattern: 'apps/*/src/domain' },
        { type: 'application', pattern: 'apps/*/src/application' },
        { type: 'infrastructure', pattern: 'apps/*/src/infrastructure' },
        { type: 'http', pattern: 'apps/*/src/http' },
        { type: 'messaging', pattern: 'apps/*/src/messaging' },
        { type: 'config', pattern: 'apps/*/src/config.ts', mode: 'file' },
        // Composition root boleh menyentuh semuanya, karena tugasnya memang
        // merangkai. Ia tersebar di dua tempat: berkas bootstrap, dan folder
        // composition untuk perangkaian yang juga dipakai pengujian.
        { type: 'composition-root', pattern: 'apps/*/src/composition' },
        { type: 'composition-root', pattern: 'apps/*/src/index.ts', mode: 'file' },
        { type: 'testing', pattern: 'apps/*/src/testing' },
      ],
    },
    rules: {
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          message: '${file.type} tidak boleh mengimpor dari ${dependency.type}',
          rules: [
            // Domain murni. Tanpa I/O, tanpa framework, tanpa broker.
            { from: 'domain', allow: ['domain'] },

            // Application mendefinisikan port dan hanya tahu domain.
            { from: 'application', allow: ['application', 'domain'] },

            // Infrastructure mengimplementasi port.
            {
              from: 'infrastructure',
              allow: ['infrastructure', 'application', 'domain', 'config'],
            },

            // Adapter masuk: HTTP dan consumer pesan.
            { from: 'http', allow: ['http', 'application', 'domain', 'config'] },
            { from: 'messaging', allow: ['messaging', 'application', 'domain', 'config'] },

            { from: 'config', allow: ['config'] },

            // Wiring hanya terjadi di composition root.
            { from: 'composition-root', allow: ['*'] },

            // Perkakas uji merangkai sistem sungguhan, jadi ia juga perangkai.
            { from: 'testing', allow: ['*'] },
          ],
        },
      ],
      'boundaries/no-private': 'off',
    },
  },
  {
    // process.env hanya boleh dibaca di config.ts — CONVENTIONS.md bagian 12
    files: ['apps/*/src/**/*.ts'],
    ignores: ['apps/*/src/config.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: 'Baca env hanya di config.ts lewat skema Zod. CONVENTIONS.md bagian 12.',
        },
      ],
    },
  },
  {
    // Aturan boundary tidak berlaku pada berkas uji. Uji memang merangkai
    // lapisan untuk mengujinya, dan itu bukan kebocoran arsitektur.
    //
    // Blok ini harus berada PALING AKHIR: konfigurasi flat ESLint dimenangkan
    // oleh yang terakhir, jadi menaruhnya sebelum blok boundary membuatnya
    // tidak berpengaruh sama sekali — tanpa galat, tanpa peringatan.
    files: ['**/*.test.ts'],
    rules: { 'boundaries/element-types': 'off' },
  },
]

export default node
