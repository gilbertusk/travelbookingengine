import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

/**
 * Aturan dasar untuk seluruh kode TypeScript di repo.
 * Penegakan dari docs/plan/CONVENTIONS.md — yang tertulis di sana sebagai
 * larangan, di sini menjadi error, bukan warning.
 */
export const base = tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      ecmaVersion: 2023,
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
      },
    },
    rules: {
      // CONVENTIONS.md bagian 3 — any dilarang, bukan dianjurkan dihindari
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/consistent-type-definitions': 'off',

      // CONVENTIONS.md bagian 5 — error tidak boleh hilang diam-diam
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/return-await': ['error', 'always'],
      'no-empty': ['error', { allowEmptyCatch: false }],

      // CONVENTIONS.md bagian 11 — log lewat logger, bukan console
      'no-console': 'error',

      // CONVENTIONS.md bagian 4 — imutabilitas.
      // req dan res dikecualikan: menulis ke res.locals adalah mekanisme
      // resmi Express untuk state per-permintaan, bukan mutasi tak sengaja
      // atas objek domain yang aturan ini dibuat untuk mencegah.
      'no-param-reassign': [
        'error',
        { props: true, ignorePropertyModificationsFor: ['req', 'res', 'acc'] },
      ],
      'prefer-const': 'error',

      // CONVENTIONS.md bagian 2 — batas ukuran
      'max-depth': ['error', 3],
      'max-lines-per-function': ['error', { max: 50, skipBlankLines: true, skipComments: true }],
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
      'max-params': ['error', 4],

      // Kebersihan umum
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'object-shorthand': 'error',
    },
  },
  {
    // Berkas uji boleh lebih panjang dan lebih longgar.
    //
    // Keluarga no-unsafe-* dimatikan di sini karena sumbernya bukan kode kita:
    // supertest mengembalikan response.body bertipe any, dan menuliskan tipe
    // untuk setiap bentuk JSON yang diperiksa hanya menambah pekerjaan tanpa
    // menambah keyakinan. no-explicit-any TETAP berlaku — menulis any sendiri
    // di berkas uji tetap dilarang.
    files: ['**/*.test.ts', '**/*.test.tsx', '**/tests/**/*.ts'],
    rules: {
      'max-lines-per-function': 'off',
      'max-lines': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      // Fixture uji sering berupa arrow function yang langsung mengembalikan
      // promise; memaksa return await di sana hanya menambah kebisingan.
      '@typescript-eslint/return-await': 'off',
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
)

export default base
