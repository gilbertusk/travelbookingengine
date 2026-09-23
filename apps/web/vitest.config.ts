import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/testing/setup.ts'],
    testTimeout: 20_000,
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/testing/**',
        'src/config.ts',
        // Berkas rute dan tata letak Next hanya merangkai; yang diuji adalah
        // komponen dan lapisan data yang dirangkainya.
        'src/app/**',
        'src/proxy.ts',
        // Perangkaian pohon klien: penyedia yang hanya membungkus children.
        'src/components/providers.tsx',
        // Primitif salinan shadcn. Perilakunya milik Radix dan sudah diuji di
        // sana; yang kita ubah hanya kelas CSS-nya.
        'src/components/ui/**',
        'src/components/design-system/**',
      ],
      reporter: ['text', 'json-summary'],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
})
