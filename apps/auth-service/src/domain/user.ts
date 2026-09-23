import type { Email } from './email.js'
import type { PasswordHash } from './password.js'

export interface User {
  readonly id: string
  readonly email: Email
  readonly passwordHash: PasswordHash
  readonly name: string
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** Bentuk pengguna yang aman dikirim ke klien. */
export interface PublicUser {
  readonly id: string
  readonly email: string
  readonly name: string
  readonly createdAt: string
}

/**
 * Mengubah pengguna menjadi bentuk publik.
 *
 * Dipakai di satu tempat dan hanya satu tempat. Membentuk respons secara
 * manual di tiap handler adalah cara paling mudah membocorkan passwordHash:
 * cukup sekali seseorang menulis `res.json(user)`.
 */
export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt.toISOString(),
  }
}
