/**
 * Header identitas internal.
 *
 * Gateway menaruh identitas hasil verifikasi ke header ini, dan service hulu
 * mempercayainya. Kepercayaan itu hanya sah bila header yang sama **tidak
 * pernah** boleh datang dari klien — kalau bisa, siapa pun dapat mengirim
 * `x-tbe-user-id: <id korban>` dan langsung menjadi orang lain.
 *
 * Pembersihannya karena itu bukan kehati-hatian tambahan; ia adalah satu-satunya
 * hal yang membuat seluruh mekanisme ini tidak menjadi celah eskalasi hak akses.
 */

export const IDENTITY_HEADER_PREFIX = 'x-tbe-'

export const USER_ID_HEADER = 'x-tbe-user-id'
export const USER_EMAIL_HEADER = 'x-tbe-user-email'

export interface ForwardedIdentity {
  readonly userId: string
  readonly email: string
}

/**
 * Header dari klien yang harus dibuang sebelum permintaan diteruskan.
 *
 * Seluruh awalan internal dibuang, bukan hanya dua nama yang kita pakai hari
 * ini. Menyebut nama satu per satu berarti setiap header internal baru
 * menambah celah sampai seseorang ingat memperbarui daftarnya.
 */
export function isClientForgedHeader(name: string): boolean {
  return name.toLowerCase().startsWith(IDENTITY_HEADER_PREFIX)
}

export function stripForgedHeaders(
  headers: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {}

  for (const [name, value] of Object.entries(headers)) {
    if (!isClientForgedHeader(name)) cleaned[name] = value
  }

  return cleaned
}

export function identityHeaders(identity: ForwardedIdentity): Record<string, string> {
  return {
    [USER_ID_HEADER]: identity.userId,
    [USER_EMAIL_HEADER]: identity.email,
  }
}

/**
 * Header yang tidak boleh diteruskan apa adanya ke hulu maupun kembali ke
 * klien, karena maknanya hanya berlaku untuk satu lompatan koneksi.
 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  // Dihitung ulang oleh lapisan HTTP; meneruskan nilai lama menghasilkan
  // respons yang terpotong atau menggantung.
  'content-length',
  'host',
])

export function isHopByHop(name: string): boolean {
  return HOP_BY_HOP_HEADERS.has(name.toLowerCase())
}
