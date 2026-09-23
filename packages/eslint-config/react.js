import next from '@next/eslint-plugin-next'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import boundaries from 'eslint-plugin-boundaries'

/**
 * Penegakan untuk aplikasi Next.js.
 *
 * Arah ketergantungan di frontend, sejalan dengan CONVENTIONS.md bagian 13:
 *
 *   app ──> components ──> ui ──┐
 *            │                  ├──> lib
 *            └──> features ─────┘
 *
 * Blok di sini TIDAK memuat aturan dasar: `base` sudah dimuat sekali lewat
 * konfigurasi node di akar repo, dan memuatnya dua kali membuat blok
 * pelonggaran untuk berkas uji tertimpa oleh salinan kedua — hasilnya ratusan
 * galat pada berkas uji backend yang sebelumnya bersih.
 *
 * Yang dijaga aturan lapisan ini ada dua. Pertama, `features/` tidak boleh mengimpor
 * komponen: logika fitur yang menarik JSX akan ikut terseret setiap kali
 * tampilannya berubah. Kedua, `components/ui/` — primitif salinan shadcn —
 * tidak boleh tahu apa pun tentang fitur; begitu ia tahu, ia bukan primitif
 * lagi dan tidak dapat dipakai ulang.
 */
export const react19 = [
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      react,
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y,
      '@next/next': next,
    },
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: {
      react: { version: 'detect' },
      // Tanpa ini plugin Next mencari folder pages di akar repo — yang tidak
      // ada, karena aplikasinya berada di dalam workspace.
      next: { rootDir: 'apps/web' },
    },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...react.configs.flat['jsx-runtime'].rules,
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      ...next.configs.recommended.rules,
      ...next.configs['core-web-vitals'].rules,

      // DESIGN-SYSTEM.md bagian 9 — aksesibilitas bukan opsional, jadi yang
      // di plugin berstatus peringatan dinaikkan menjadi galat.
      'jsx-a11y/alt-text': 'error',
      'jsx-a11y/anchor-is-valid': 'error',
      'jsx-a11y/label-has-associated-control': 'error',
      'jsx-a11y/no-autofocus': 'error',

      // Prop tervalidasi lewat tipe TypeScript; propTypes runtime hanya
      // menduplikasi hal yang sama dengan cara yang lebih lemah.
      'react/prop-types': 'off',
    },
  },
  {
    // CONVENTIONS.md bagian 13 menetapkan batas komponen 150 baris, bukan 50
    // seperti fungsi biasa. JSX memang panjang secara wajar: satu komponen
    // formulir yang benar — dengan label, pesan galat, dan atribut aria —
    // melewati 50 baris tanpa melakukan lebih dari satu hal.
    files: ['**/*.tsx'],
    rules: {
      'max-lines-per-function': ['error', { max: 150, skipBlankLines: true, skipComments: true }],

      // Penangan peristiwa React bertipe mengembalikan void. Menyerahkan
      // fungsi async kepadanya adalah pola yang wajar, dan risiko promise
      // yang terlepas sudah ditangani no-floating-promises.
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
    },
  },
  {
    files: ['apps/*/src/**/*.{ts,tsx}'],
    plugins: { boundaries },
    settings: {
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: ['apps/*/tsconfig.json'],
        },
      },
      'boundaries/elements': [
        { type: 'app', pattern: 'apps/*/src/app' },
        { type: 'ui', pattern: 'apps/*/src/components/ui' },
        { type: 'components', pattern: 'apps/*/src/components' },
        { type: 'features', pattern: 'apps/*/src/features' },
        { type: 'lib', pattern: 'apps/*/src/lib' },
        { type: 'config', pattern: 'apps/*/src/config.ts', mode: 'file' },
      ],
    },
    rules: {
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          message: '${file.type} tidak boleh mengimpor dari ${dependency.type}',
          rules: [
            { from: 'app', allow: ['*'] },
            { from: 'components', allow: ['components', 'ui', 'features', 'lib', 'config'] },
            { from: 'ui', allow: ['ui', 'lib'] },
            { from: 'features', allow: ['features', 'lib', 'config'] },
            { from: 'lib', allow: ['lib', 'config'] },
            { from: 'config', allow: ['config'] },
          ],
        },
      ],
      'boundaries/no-private': 'off',
    },
  },
  {
    // CONVENTIONS.md bagian 12 — env hanya dibaca di config.ts.
    //
    // Di Next.js ini bukan sekadar kerapian: nilai NEXT_PUBLIC_* disubstitusi
    // saat build berdasarkan kemunculan literal `process.env.NAMA`, jadi
    // membacanya lewat variabel akan menghasilkan undefined di peramban —
    // kegagalan yang hanya muncul setelah build produksi.
    files: ['apps/*/src/**/*.{ts,tsx}'],
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
    // Sama seperti pada konfigurasi node: blok pelonggaran untuk berkas uji
    // HARUS paling akhir, karena konfigurasi flat dimenangkan yang terakhir.
    files: ['**/*.test.{ts,tsx}', '**/testing/**'],
    rules: {
      'boundaries/element-types': 'off',
      'max-lines-per-function': 'off',
    },
  },
]

export default react19
