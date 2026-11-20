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
        // Berkas rute dan tata letak Next hanya merangkai; keputusan yang
        // dirangkainya ada di src/lib dan src/features, dan diuji di sana.
        'src/app/**',
        'src/proxy.ts',
        'src/components/providers.tsx',
      ],
      reporter: ['text', 'json-summary'],
      // Sama dengan apps/web — tidak diturunkan untuk panel "yang boleh
      // tidak dipoles": tampilannya boleh polos, logikanya tidak boleh longgar.
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
})
