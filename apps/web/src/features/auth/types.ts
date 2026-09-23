import { z } from 'zod'

/**
 * Bentuk data autentikasi.
 *
 * Skema kredensial ditulis ulang di sini, bukan diimpor dari auth-service.
 * Alasannya: aturan yang berlaku di frontend adalah aturan bentuk masukan
 * untuk formulir, bukan aturan domain. Mengimpor skema server akan menyeret
 * seluruh paket server ke bundel peramban demi tiga baris validasi.
 *
 * Batas panjang kata sandi tetap disamakan dengan auth-service supaya
 * pengguna tidak mengetik dua belas karakter lalu ditolak server.
 */

const MIN_PASSWORD_LENGTH = 12
const MAX_PASSWORD_LENGTH = 128

export const loginSchema = z.object({
  email: z.email({ message: 'Masukkan alamat surel yang benar.' }),
  password: z.string().min(1, { message: 'Kata sandi belum diisi.' }).max(MAX_PASSWORD_LENGTH),
})

export const registerSchema = z.object({
  name: z.string().trim().min(1, { message: 'Nama belum diisi.' }).max(120),
  email: z.email({ message: 'Masukkan alamat surel yang benar.' }),
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, {
      message: `Kata sandi minimal ${String(MIN_PASSWORD_LENGTH)} karakter.`,
    })
    .max(MAX_PASSWORD_LENGTH),
})

export type LoginInput = z.infer<typeof loginSchema>
export type RegisterInput = z.infer<typeof registerSchema>

export interface User {
  readonly id: string
  readonly email: string
  readonly name: string
  readonly createdAt: string
}

export interface Session {
  readonly user: User
  readonly accessToken: string
}

export { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH }
