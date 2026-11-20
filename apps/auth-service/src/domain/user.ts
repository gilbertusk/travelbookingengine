import type { Email } from './email.js'
import type { PasswordHash } from './password.js'

/**
 * Peran pengguna (Step 27). Didefinisikan ulang di sini, bukan diimpor dari
 * shared-kernel, karena domain auth adalah PEMILIK peran: shared-kernel hanya
 * membaca header yang dipasang gateway dari token yang diterbitkan di sini.
 * Uji di domain.test.ts memastikan kedua daftar sama persis.
 */
export const ROLES = ['customer', 'operator'] as const
export type Role = (typeof ROLES)[number]

export interface User {
  readonly id: string
  readonly email: Email
  readonly passwordHash: PasswordHash
  readonly name: string
  readonly role: Role
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** Bentuk pengguna yang aman dikirim ke klien. */
export interface PublicUser {
  readonly id: string
  readonly email: string
  readonly name: string
  /**
   * Ikut dikirim: panel operator membutuhkannya untuk menolak masuk lebih
   * awal dengan pesan yang jelas. Bukan rahasia, dan bukan pula batas
   * keamanan — batasnya di gateway dan service.
   */
  readonly role: Role
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
    role: user.role,
    createdAt: user.createdAt.toISOString(),
  }
}
