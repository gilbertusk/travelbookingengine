import { SignJWT } from 'jose'
import { beforeAll, describe, expect, test } from 'vitest'
import { createJoseVerifier } from './jose-verifier.js'

/**
 * Verifikasi token diuji dengan token sungguhan, bukan tiruan.
 *
 * Inilah batas kepercayaan seluruh sistem: sembilan service hulu menerima
 * header identitas apa adanya karena gateway sudah memeriksanya di sini.
 * Menirukan pustaka jwt berarti menguji tiruannya, bukan pemeriksaannya.
 */

const SECRET = 'rahasia-pengujian-yang-cukup-panjang-untuk-hs256'
const ISSUER = 'tbe-auth'
const AUDIENCE = 'tbe-api'

const verifier = createJoseVerifier({ secret: SECRET, issuer: ISSUER, audience: AUDIENCE })

interface TokenOptions {
  readonly secret?: string
  readonly issuer?: string
  readonly audience?: string
  readonly subject?: string | undefined
  readonly email?: unknown
  readonly expiresIn?: string
}

async function sign(options: TokenOptions = {}): Promise<string> {
  const builder = new SignJWT(options.email === undefined ? {} : { email: options.email })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setExpirationTime(options.expiresIn ?? '5m')

  if (options.subject !== undefined) builder.setSubject(options.subject)

  return builder.sign(new TextEncoder().encode(options.secret ?? SECRET))
}

let tokenSah: string

beforeAll(async () => {
  tokenSah = await sign({ subject: 'usr_1', email: 'budi@example.com' })
})

describe('verifikasi token akses', () => {
  test('menerima token yang sah dan mengembalikan identitasnya', async () => {
    await expect(verifier.verify(tokenSah)).resolves.toEqual({
      userId: 'usr_1',
      email: 'budi@example.com',
    })
  })

  test('menolak token yang ditandatangani rahasia lain', async () => {
    const token = await sign({
      subject: 'usr_1',
      email: 'budi@example.com',
      secret: 'rahasia-lain-yang-juga-cukup-panjang-untuk-hs256',
    })

    await expect(verifier.verify(token)).resolves.toBeUndefined()
  })

  test('menolak token yang tidak bertanda tangan sama sekali', async () => {
    // Serangan alg=none: penyerang menulis ulang header menjadi "none",
    // mengosongkan tanda tangan, dan mengarang isi payload sesukanya.
    // Pustaka yang mempercayai header token akan menerimanya; daftar
    // algoritma eksplisit di verifier inilah yang menutup celah itu.
    const encode = (value: unknown): string =>
      Buffer.from(JSON.stringify(value)).toString('base64url')

    const palsu = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
      sub: 'usr_admin',
      email: 'penyerang@example.com',
      iss: ISSUER,
      aud: AUDIENCE,
    })}.`

    await expect(verifier.verify(palsu)).resolves.toBeUndefined()
  })

  test('menolak token dari penerbit lain', async () => {
    const token = await sign({ subject: 'usr_1', email: 'budi@example.com', issuer: 'bukan-kami' })

    await expect(verifier.verify(token)).resolves.toBeUndefined()
  })

  test('menolak token yang ditujukan untuk audiens lain', async () => {
    // Token untuk aplikasi admin internal tidak boleh dapat dipakai di sini
    // hanya karena penandatangannya sama.
    const token = await sign({ subject: 'usr_1', email: 'budi@example.com', audience: 'tbe-admin' })

    await expect(verifier.verify(token)).resolves.toBeUndefined()
  })

  test('menolak token yang sudah kedaluwarsa', async () => {
    const token = await sign({ subject: 'usr_1', email: 'budi@example.com', expiresIn: '-1m' })

    await expect(verifier.verify(token)).resolves.toBeUndefined()
  })

  test('menolak token sah yang tidak membawa subjek', async () => {
    // Tanda tangannya benar, tetapi tanpa sub tidak ada identitas yang dapat
    // diteruskan. Meneruskan header identitas kosong jauh lebih berbahaya
    // daripada menolak.
    const token = await sign({ email: 'budi@example.com' })

    await expect(verifier.verify(token)).resolves.toBeUndefined()
  })

  test('menolak token sah yang klaim email-nya bukan string', async () => {
    const token = await sign({ subject: 'usr_1', email: { nested: 'object' } })

    await expect(verifier.verify(token)).resolves.toBeUndefined()
  })

  test('menolak masukan yang sama sekali bukan token', async () => {
    for (const masukan of ['', 'bukan-token', 'a.b.c']) {
      await expect(verifier.verify(masukan)).resolves.toBeUndefined()
    }
  })
})
