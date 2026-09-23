import { describe, expect, test } from 'vitest'
import { createEmail, normalizeEmail } from './email.js'
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, validatePassword } from './password.js'
import { evaluateSession, isActive, type RefreshSession } from './session.js'
import { toPublicUser } from './user.js'
import type { Email } from './email.js'
import { asPasswordHash } from './password.js'

const NOW = new Date('2026-09-23T10:00:00Z')

function session(overrides: Partial<RefreshSession> = {}): RefreshSession {
  return {
    id: 'sess-1',
    userId: 'user-1',
    tokenHash: 'hash-1',
    familyId: 'fam-1',
    expiresAt: new Date('2026-10-23T10:00:00Z'),
    revokedAt: undefined,
    usedAt: undefined,
    replacedById: undefined,
    ...overrides,
  }
}

describe('email', () => {
  test('menormalkan spasi dan huruf besar', () => {
    // Tanpa normalisasi, "Budi@Example.com " dan "budi@example.com" menjadi
    // dua akun berbeda, dan batasan unik tidak mencegahnya.
    expect(normalizeEmail('  Budi@Example.COM ')).toBe('budi@example.com')
  })

  test('menerima alamat yang wajar', () => {
    const hasil = createEmail('  Budi.Santoso@Example.co.id ')

    expect(hasil.ok && hasil.value).toBe('budi.santoso@example.co.id')
  })

  test('menolak alamat kosong', () => {
    expect(createEmail('   ')).toEqual({ ok: false, error: 'empty' })
  })

  test('menolak bentuk yang jelas salah', () => {
    for (const buruk of ['tanpa-at', 'a@b', 'a@@b.com', 'spasi di@tengah.com', '@example.com']) {
      expect(createEmail(buruk).ok).toBe(false)
    }
  })

  test('menolak alamat yang terlalu panjang', () => {
    expect(createEmail(`${'a'.repeat(250)}@example.com`)).toEqual({ ok: false, error: 'too_long' })
  })
})

describe('kata sandi', () => {
  test('menerima kata sandi yang memenuhi panjang minimum', () => {
    expect(validatePassword('kataSandiPanjangAman')).toBeUndefined()
  })

  test('menolak yang terlalu pendek', () => {
    expect(validatePassword('a'.repeat(MIN_PASSWORD_LENGTH - 1))).toBe('too_short')
  })

  test('menolak yang terlalu panjang', () => {
    // Batas atas demi ketahanan, bukan keamanan: Argon2 sengaja lambat, dan
    // kata sandi raksasa adalah cara murah membuat server sibuk.
    expect(validatePassword('a'.repeat(MAX_PASSWORD_LENGTH + 1))).toBe('too_long')
  })

  test('menolak kata sandi yang paling sering dipakai', () => {
    expect(validatePassword('password1234')).toBe('too_common')
    expect(validatePassword('PASSWORD1234')).toBe('too_common')
  })
})

describe('sesi refresh', () => {
  test('sesi yang masih berlaku tidak bermasalah', () => {
    expect(evaluateSession(session(), NOW)).toBeUndefined()
    expect(isActive(session(), NOW)).toBe(true)
  })

  test('sesi yang tidak ditemukan dilaporkan sebagai not_found', () => {
    expect(evaluateSession(undefined, NOW)).toBe('not_found')
  })

  test('sesi kedaluwarsa dilaporkan sebagai expired', () => {
    const lewat = session({ expiresAt: new Date('2026-09-22T10:00:00Z') })

    expect(evaluateSession(lewat, NOW)).toBe('expired')
  })

  test('sesi yang tepat kedaluwarsa pada detik ini sudah tidak berlaku', () => {
    expect(evaluateSession(session({ expiresAt: NOW }), NOW)).toBe('expired')
  })

  test('sesi yang dicabut dilaporkan sebagai revoked', () => {
    expect(evaluateSession(session({ revokedAt: NOW }), NOW)).toBe('revoked')
  })

  test('token yang sudah terpakai dilaporkan sebagai reused', () => {
    expect(evaluateSession(session({ usedAt: NOW }), NOW)).toBe('reused')
  })

  test('pemakaian ulang diperiksa sebelum kedaluwarsa dan pencabutan', () => {
    // Token curian yang kebetulan juga sudah kedaluwarsa tetap harus memicu
    // pencabutan keluarga, bukan sekadar dilaporkan kedaluwarsa dan dilupakan.
    const curian = session({
      usedAt: NOW,
      revokedAt: NOW,
      expiresAt: new Date('2026-09-01T00:00:00Z'),
    })

    expect(evaluateSession(curian, NOW)).toBe('reused')
  })
})

describe('bentuk publik pengguna', () => {
  test('tidak pernah menyertakan hash kata sandi', () => {
    // Cukup sekali seseorang menulis res.json(user) untuk membocorkannya.
    const publik = toPublicUser({
      id: 'user-1',
      email: 'budi@example.com' as Email,
      passwordHash: asPasswordHash('$argon2id$rahasia'),
      name: 'Budi',
      createdAt: NOW,
      updatedAt: NOW,
    })

    expect(JSON.stringify(publik)).not.toContain('argon2')
    expect(publik).not.toHaveProperty('passwordHash')
    expect(publik).not.toHaveProperty('updatedAt')
  })
})
