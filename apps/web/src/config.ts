import { z } from 'zod'

/**
 * Satu-satunya tempat process.env dibaca.
 *
 * Di Next.js aturan ini punya konsekuensi teknis, bukan sekadar kerapian:
 * nilai `NEXT_PUBLIC_*` disubstitusi saat build berdasarkan kemunculan
 * literal `process.env.NAMA` di dalam kode. Membacanya lewat variabel
 * perantara menghasilkan `undefined` di peramban — dan kegagalannya baru
 * muncul setelah build produksi, bukan saat pengembangan.
 */

const publicSchema = z.object({
  /** Alamat api-gateway yang dipanggil dari peramban. */
  apiUrl: z.url(),
  appName: z.string().min(1),
  /**
   * Client key Midtrans untuk popup Snap. Publik menurut rancangannya — kunci
   * server tidak pernah ada di sini. Kosong berarti popup tidak dipakai dan
   * pengguna diarahkan ke halaman Snap penuh (lihat features/booking/snap.ts).
   */
  midtransClientKey: z.string().min(1).optional(),
  snapScriptUrl: z.url(),
  /**
   * Alamat bantuan untuk pemesanan yang diperiksa manual (Step 26). Pengguna
   * yang uangnya sedang ditahan harus punya cara menghubungi seseorang.
   */
  supportEmail: z.email(),
})

export type PublicConfig = z.infer<typeof publicSchema>

export const publicConfig: PublicConfig = publicSchema.parse({
  apiUrl: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4001',
  appName: process.env.NEXT_PUBLIC_APP_NAME ?? 'Lintang',
  // Nilai kosong di .env sama dengan tidak diatur: popup tidak dipakai.
  midtransClientKey: blankToUndefined(process.env.NEXT_PUBLIC_MIDTRANS_CLIENT_KEY),
  snapScriptUrl:
    process.env.NEXT_PUBLIC_MIDTRANS_SNAP_URL ?? 'https://app.sandbox.midtrans.com/snap/snap.js',
  supportEmail: process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? 'bantuan@lintang.example',
})

const serverSchema = z.object({
  /**
   * Alamat gateway dari sisi server. Dipisahkan dari yang publik karena di
   * lingkungan terkontainer keduanya berbeda: peramban memanggil nama host
   * publik, server memanggil nama service di jaringan internal.
   */
  apiUrl: z.url(),
  /**
   * Cookie hanya dikirim lewat HTTPS di luar pengembangan. Dipisah sebagai
   * nilai eksplisit supaya tidak ada yang lupa menyalakannya saat rilis.
   */
  secureCookies: z.boolean(),
})

export type ServerConfig = z.infer<typeof serverSchema>

/**
 * Dibaca lewat fungsi, bukan konstanta modul, supaya variabel khusus server
 * tidak pernah ikut terbaca saat modul ini dimuat di peramban.
 */
export function serverConfig(): ServerConfig {
  return serverSchema.parse({
    apiUrl: process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4001',
    secureCookies: process.env.NODE_ENV === 'production',
  })
}

function blankToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value
}
