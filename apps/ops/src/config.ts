import { z } from 'zod'

/**
 * Satu-satunya tempat process.env dibaca (CONVENTIONS.md bagian 12).
 *
 * Panel operator TIDAK punya konfigurasi publik (`NEXT_PUBLIC_*`) sama sekali:
 * peramban tidak pernah memanggil gateway langsung. Semua panggilan lewat
 * rute server aplikasi ini (`/api/ops/...`), yang menyisipkan token dari
 * cookie httpOnly. Alamat gateway, dan bentuk API operator, tidak pernah
 * sampai ke JavaScript halaman.
 */

const serverSchema = z.object({
  /** Alamat api-gateway dari sisi server. */
  apiUrl: z.url(),
  /** Cookie hanya lewat HTTPS di luar pengembangan. */
  secureCookies: z.boolean(),
})

export type ServerConfig = z.infer<typeof serverSchema>

export function serverConfig(): ServerConfig {
  return serverSchema.parse({
    apiUrl: process.env.API_URL ?? 'http://localhost:4001',
    secureCookies: process.env.NODE_ENV === 'production',
  })
}
