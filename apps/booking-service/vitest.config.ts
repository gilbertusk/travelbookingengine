import { defineConfig } from 'vitest/config'

/**
 * Zona waktu proses uji SENGAJA bukan UTC.
 *
 * Tanggal menginap disimpan sebagai kolom `DATE` (NFR-09), dan cacat klasik di
 * pemetaan kolom itu — `getDate()` alih-alih `getUTCDate()`, `new Date(y, m, d)`
 * alih-alih `Date.UTC` — tidak terlihat sama sekali pada mesin ber-UTC. Mesin CI
 * dan kontainer hampir selalu UTC, jadi uji yang berjalan di sana akan hijau
 * untuk kode yang menggeser seluruh menginap satu hari di laptop pengembang di
 * Jakarta atau di server di Los Angeles.
 *
 * America/Los_Angeles dipilih karena berada di belakang UTC: tengah malam UTC
 * tanggal 1 di sana masih tanggal 30 bulan sebelumnya, sehingga pembacaan
 * dengan zona lokal menghasilkan tanggal yang SALAH, bukan kebetulan benar.
 * Uji di infrastructure/booking-rows.test.ts memastikan zona ini benar-benar
 * berlaku, supaya penjagaannya tidak diam-diam hilang.
 *
 * Ditulis di sini, bukan di berkas uji: `process.env` hanya boleh dibaca dan
 * ditulis di config.ts di bawah src/, dan zona waktu harus ditetapkan sebelum
 * pekerja uji dimulai.
 */
process.env.TZ = 'America/Los_Angeles'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/config.ts',
        'src/index.ts',
        'src/telemetry.ts',
        // Klien Prisma sungguhan: pembuatan koneksi saja. Kesesuaian tipenya
        // dengan port BookingDb dibuktikan compiler di berkas itu sendiri.
        'src/infrastructure/prisma-client.ts',
        // Adapter Redis diuji terhadap Redis SUNGGUHAN di tests/integration,
        // bukan terhadap tiruan: yang dibuktikan di sana adalah atomisitas
        // skrip Lua dan keyspace notification, dan keduanya sifat Redis, bukan
        // sifat kode kita. Fungsi murni di dalamnya (bookingIdOfExpiredKey,
        // notifiesExpiry) tetap diuji unit.
        'src/infrastructure/redis-hold-store.ts',
        'src/infrastructure/keyspace-expiry.ts',
        // Jembatan tipis ke Date dan crypto.randomUUID.
        'src/infrastructure/system.ts',
        'src/generated/**',
        'src/testing/**',
      ],
      reporter: ['text', 'json-summary'],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 85,
        statements: 85,
        // Step 16 domain murni, dan domain murni tidak punya alasan untuk
        // cabang yang tidak teruji: tidak ada jaringan, tidak ada basis data,
        // tidak ada waktu nyata. Ambangnya lebih tinggi dari service lain.
        'src/domain/**': { lines: 95, functions: 95, branches: 95, statements: 95 },
      },
    },
  },
})
