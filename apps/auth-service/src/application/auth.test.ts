import { describe, expect, test } from 'vitest'
import { createAuthHarness, DAY_MS, type AuthHarness } from '../testing/fakes.js'
import { authenticateUser } from './authenticate-user.js'
import { getProfile, revokeSession, updateProfile } from './manage-session.js'
import { refreshSession } from './refresh-session.js'
import { registerUser } from './register-user.js'
import type { LoginAttemptLimiter } from './ports.js'

const EMAIL = 'budi@example.com'
const PASSWORD = 'kataSandiPanjangAman'

async function registered(harness: AuthHarness, email = EMAIL) {
  const result = await registerUser(harness.deps, { email, password: PASSWORD, name: 'Budi' })
  if (!result.ok) throw new Error('pendaftaran seharusnya berhasil')
  return result.value
}

describe('pendaftaran', () => {
  test('membuat pengguna dan langsung menerbitkan sepasang token', async () => {
    const harness = createAuthHarness()

    const { user, tokens } = await registered(harness)

    expect(user.email).toBe(EMAIL)
    expect(tokens.accessToken.length).toBeGreaterThan(0)
    expect(tokens.refreshToken.length).toBeGreaterThan(0)
  })

  test('menormalkan surel sebelum menyimpan', async () => {
    const harness = createAuthHarness()

    const { user } = await registered(harness, '  Budi@EXAMPLE.com ')

    expect(user.email).toBe(EMAIL)
  })

  test('menolak surel yang sudah terdaftar, termasuk dengan huruf berbeda', async () => {
    const harness = createAuthHarness()
    await registered(harness)

    const kedua = await registerUser(harness.deps, {
      email: 'BUDI@example.com',
      password: PASSWORD,
      name: 'Budi Lain',
    })

    expect(kedua.ok).toBe(false)
    expect(kedua.ok ? undefined : kedua.error.kind).toBe('email_taken')
  })

  test('menolak kata sandi lemah sebelum menyentuh repository', async () => {
    const harness = createAuthHarness()

    const hasil = await registerUser(harness.deps, { email: EMAIL, password: 'pendek', name: 'B' })

    expect(hasil.ok).toBe(false)
    expect(await harness.deps.users.findByEmail(EMAIL as never)).toBeUndefined()
  })

  test('tidak pernah menyimpan kata sandi dalam bentuk aslinya', async () => {
    const harness = createAuthHarness()

    const { user } = await registered(harness)

    expect(user.passwordHash).not.toBe(PASSWORD)
    expect(user.passwordHash).toContain('fake$')
  })
})

describe('masuk', () => {
  test('berhasil dengan kredensial yang benar', async () => {
    const harness = createAuthHarness()
    await registered(harness)

    const hasil = await authenticateUser(harness.deps, { email: EMAIL, password: PASSWORD })

    expect(hasil.ok).toBe(true)
  })

  test('menolak kata sandi salah', async () => {
    const harness = createAuthHarness()
    await registered(harness)

    const hasil = await authenticateUser(harness.deps, { email: EMAIL, password: 'salahSekali123' })

    expect(hasil.ok ? undefined : hasil.error.kind).toBe('invalid_credentials')
  })

  test('surel tidak terdaftar menghasilkan galat yang sama persis', async () => {
    // Membedakan keduanya memberi tahu penyerang akun mana yang ada.
    const harness = createAuthHarness()
    await registered(harness)

    const tidakAda = await authenticateUser(harness.deps, {
      email: 'orang.lain@example.com',
      password: PASSWORD,
    })
    const salahSandi = await authenticateUser(harness.deps, {
      email: EMAIL,
      password: 'salahSekali123',
    })

    expect(tidakAda).toEqual(salahSandi)
  })

  test('verifikasi tetap dijalankan meski akun tidak ada', async () => {
    // Melewatinya membuat permintaan untuk surel tak terdaftar kembali jauh
    // lebih cepat, dan selisih waktu itu memetakan siapa saja yang punya akun.
    const harness = createAuthHarness()
    let verifikasi = 0
    const asli = harness.deps.hasher.verify.bind(harness.deps.hasher)
    const deps = {
      ...harness.deps,
      hasher: {
        ...harness.deps.hasher,
        verify: async (hash: never, raw: never) => {
          verifikasi += 1
          return await asli(hash, raw)
        },
      },
    }

    await authenticateUser(deps, { email: 'tidak.ada@example.com', password: PASSWORD })

    expect(verifikasi).toBe(1)
  })

  test('menolak ketika pembatas percobaan memblokir akun', async () => {
    const blokir: LoginAttemptLimiter = {
      isBlocked: async () => Promise.resolve(true),
      recordFailure: async () => Promise.resolve(),
      reset: async () => Promise.resolve(),
    }
    const harness = createAuthHarness({ limiter: blokir })
    await registered(harness)

    const hasil = await authenticateUser(harness.deps, { email: EMAIL, password: PASSWORD })

    expect(hasil.ok ? undefined : hasil.error.kind).toBe('too_many_attempts')
  })

  test('mencatat kegagalan dan mengosongkan hitungan setelah berhasil', async () => {
    const dicatat: string[] = []
    const direset: string[] = []
    const limiter: LoginAttemptLimiter = {
      isBlocked: async () => Promise.resolve(false),
      recordFailure: async (key) => {
        dicatat.push(key)
        await Promise.resolve()
      },
      reset: async (key) => {
        direset.push(key)
        await Promise.resolve()
      },
    }
    const harness = createAuthHarness({ limiter })
    await registered(harness)

    await authenticateUser(harness.deps, { email: EMAIL, password: 'salahSekali123' })
    await authenticateUser(harness.deps, { email: EMAIL, password: PASSWORD })

    expect(dicatat).toEqual([EMAIL])
    expect(direset).toEqual([EMAIL])
  })
})

describe('rotasi refresh token', () => {
  test('menukar token lama dengan sepasang token baru', async () => {
    const harness = createAuthHarness()
    const { tokens } = await registered(harness)

    const hasil = await refreshSession(harness.deps, { refreshToken: tokens.refreshToken })

    expect(hasil.ok).toBe(true)
    expect(hasil.ok ? hasil.value.refreshToken : '').not.toBe(tokens.refreshToken)
  })

  test('token lama tidak dapat dipakai lagi setelah dirotasi', async () => {
    const harness = createAuthHarness()
    const { tokens } = await registered(harness)
    await refreshSession(harness.deps, { refreshToken: tokens.refreshToken })

    const ulang = await refreshSession(harness.deps, { refreshToken: tokens.refreshToken })

    expect(ulang.ok).toBe(false)
    expect(ulang.ok ? undefined : ulang.error.reason).toBe('reused')
  })

  test('pemakaian ulang mencabut SELURUH keluarga token', async () => {
    // Inti keamanannya. Mencabut satu token saja membuat token curian
    // berikutnya tetap hidup, dan korban tidak pernah tahu.
    const harness = createAuthHarness()
    const { tokens } = await registered(harness)
    const kedua = await refreshSession(harness.deps, { refreshToken: tokens.refreshToken })
    const tokenKedua = kedua.ok ? kedua.value.refreshToken : ''

    // Penyerang memakai token pertama yang sudah dicuri
    await refreshSession(harness.deps, { refreshToken: tokens.refreshToken })

    // Token kedua milik pengguna asli ikut mati
    const setelah = await refreshSession(harness.deps, { refreshToken: tokenKedua })
    expect(setelah.ok).toBe(false)
    expect(setelah.ok ? undefined : setelah.error.reason).toBe('revoked')
  })

  test('menandai pencabutan keluarga agar dapat dicatat sebagai peristiwa keamanan', async () => {
    const harness = createAuthHarness()
    const { tokens } = await registered(harness)
    await refreshSession(harness.deps, { refreshToken: tokens.refreshToken })

    const hasil = await refreshSession(harness.deps, { refreshToken: tokens.refreshToken })

    expect(hasil.ok ? undefined : hasil.error.familyRevoked).toBe(true)
  })

  test('token yang tidak dikenal ditolak tanpa mencabut apa pun', async () => {
    const harness = createAuthHarness()

    const hasil = await refreshSession(harness.deps, { refreshToken: 'bukan-token' })

    expect(hasil.ok ? undefined : hasil.error.reason).toBe('not_found')
    expect(hasil.ok ? undefined : hasil.error.familyRevoked).toBe(false)
  })

  test('token kedaluwarsa ditolak', async () => {
    const harness = createAuthHarness()
    const { tokens } = await registered(harness)

    harness.clock.advance(31 * DAY_MS)
    const hasil = await refreshSession(harness.deps, { refreshToken: tokens.refreshToken })

    expect(hasil.ok ? undefined : hasil.error.reason).toBe('expired')
  })

  test('rotasi berantai tetap berada dalam satu keluarga', async () => {
    const harness = createAuthHarness()
    let current = (await registered(harness)).tokens.refreshToken

    for (let putaran = 0; putaran < 3; putaran += 1) {
      const hasil = await refreshSession(harness.deps, { refreshToken: current })
      expect(hasil.ok).toBe(true)
      current = hasil.ok ? hasil.value.refreshToken : ''
    }

    // Mencabut lewat token terakhir harus mematikan seluruh rantai
    await revokeSession(harness.deps, current)
    const setelah = await refreshSession(harness.deps, { refreshToken: current })
    expect(setelah.ok).toBe(false)
  })
})

describe('keluar', () => {
  test('mencabut keluarga token dan membuat refresh berikutnya gagal', async () => {
    const harness = createAuthHarness()
    const { tokens } = await registered(harness)

    const hasil = await revokeSession(harness.deps, tokens.refreshToken)

    expect(hasil).toBe('revoked')
    expect((await refreshSession(harness.deps, { refreshToken: tokens.refreshToken })).ok).toBe(
      false,
    )
  })

  test('token yang tidak dikenal dijawab tanpa galat', async () => {
    // Membedakan "tidak ditemukan" dari "berhasil dicabut" memberi cara
    // menebak token mana yang masih hidup.
    const harness = createAuthHarness()

    expect(await revokeSession(harness.deps, 'bukan-token')).toBe('already_inactive')
  })

  test('keluar dua kali tidak menghasilkan galat', async () => {
    const harness = createAuthHarness()
    const { tokens } = await registered(harness)

    await revokeSession(harness.deps, tokens.refreshToken)

    expect(await revokeSession(harness.deps, tokens.refreshToken)).toBe('already_inactive')
  })
})

describe('profil', () => {
  test('mengembalikan pengguna yang ada', async () => {
    const harness = createAuthHarness()
    const { user } = await registered(harness)

    const hasil = await getProfile(harness.deps, user.id)

    expect(hasil.ok && hasil.value.id).toBe(user.id)
  })

  test('menolak pengguna yang tidak ada', async () => {
    const harness = createAuthHarness()

    expect((await getProfile(harness.deps, 'tidak-ada')).ok).toBe(false)
  })

  test('memperbarui nama dan memangkas spasi', async () => {
    const harness = createAuthHarness()
    const { user } = await registered(harness)

    const hasil = await updateProfile(harness.deps, user.id, '  Budi Santoso  ')

    expect(hasil.ok && hasil.value.name).toBe('Budi Santoso')
  })

  test('memperbarui pengguna yang tidak ada ditolak', async () => {
    const harness = createAuthHarness()

    expect((await updateProfile(harness.deps, 'tidak-ada', 'X')).ok).toBe(false)
  })
})
