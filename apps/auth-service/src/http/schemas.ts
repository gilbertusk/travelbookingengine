import { validate } from '@tbe/shared-kernel'
import { z } from 'zod'
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../domain/password.js'

/**
 * Skema permintaan.
 *
 * Validasi di sini hanya soal bentuk: ada, bertipe benar, panjang masuk akal.
 * Aturan domain — kekuatan kata sandi, bentuk surel — tetap tinggal di domain,
 * karena aturan itu juga berlaku bagi pemanggil yang tidak lewat HTTP.
 */

export const registerSchema = z.object({
  email: z.string().min(3).max(254),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
  name: z.string().trim().min(1).max(120),
})

export const loginSchema = z.object({
  email: z.string().min(3).max(254),
  // Tidak ada batas minimum di sini. Menolak kata sandi pendek saat masuk
  // memberi tahu penyerang bahwa aturan panjangnya, dan tidak menambah
  // keamanan apa pun.
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
})

export const refreshSchema = z.object({
  refreshToken: z.string().min(1).max(512),
})

export const updateProfileSchema = z.object({
  name: z.string().trim().min(1).max(120),
})

export const registerBody = validate(registerSchema, 'body')
export const loginBody = validate(loginSchema, 'body')
export const refreshBody = validate(refreshSchema, 'body')
export const updateProfileBody = validate(updateProfileSchema, 'body')
