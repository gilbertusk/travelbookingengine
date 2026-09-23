/**
 * Penyimpanan access token.
 *
 * Di memori, tidak di localStorage. Token yang dapat dibaca `localStorage`
 * juga dapat dibaca skrip pihak ketiga mana pun yang berhasil masuk ke
 * halaman, dan satu kebocoran berarti token itu dapat dipakai sampai
 * kedaluwarsa tanpa jejak.
 *
 * Konsekuensinya: token hilang saat halaman dimuat ulang. Itu disengaja —
 * refresh token ada di cookie httpOnly, dan aplikasi memulihkan sesi dengan
 * satu panggilan refresh saat dimuat. Lihat [AuthProvider].
 */

let accessToken: string | undefined

/** Pelanggan yang ingin tahu saat token berganti, misalnya menu akun. */
const listeners = new Set<() => void>()

export function getAccessToken(): string | undefined {
  return accessToken
}

export function setAccessToken(token: string | undefined): void {
  accessToken = token
  for (const notify of listeners) notify()
}

export function subscribeToAccessToken(listener: () => void): () => void {
  listeners.add(listener)

  return () => {
    listeners.delete(listener)
  }
}
