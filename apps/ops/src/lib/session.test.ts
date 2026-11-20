// @vitest-environment node
import { NextResponse } from 'next/server'
import { describe, expect, test } from 'vitest'
import { TOKENS } from '@/testing/fakes'
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  REFRESH_MAX_AGE_SECONDS,
  applySession,
  sessionFrom,
} from './session'

function cookieHeader(response: NextResponse): string {
  return response.headers.getSetCookie().join('\n')
}

describe('cookie sesi panel', () => {
  test('token baru: kedua cookie httpOnly, SameSite=Strict, umur sesuai', () => {
    const response = applySession(
      NextResponse.json({}),
      { kind: 'renewed', tokens: TOKENS },
      { secure: true },
    )
    const header = cookieHeader(response)

    expect(header).toContain(`${ACCESS_COOKIE}=akses-baru`)
    expect(header).toContain(`Max-Age=${String(TOKENS.expiresIn)}`)
    expect(header).toContain(`${REFRESH_COOKIE}=segar-baru`)
    expect(header).toContain(`Max-Age=${String(REFRESH_MAX_AGE_SECONDS)}`)
    expect(header.match(/HttpOnly/gi)).toHaveLength(2)
    expect(header.match(/SameSite=strict/gi)).toHaveLength(2)
    expect(header.match(/Secure/g)).toHaveLength(2)
  })

  test('hapus: kedua cookie kedaluwarsa seketika', () => {
    const header = cookieHeader(
      applySession(NextResponse.json({}), { kind: 'clear' }, { secure: false }),
    )

    expect(header.match(/Max-Age=0/g)).toHaveLength(2)
    expect(header).not.toContain('Secure')
  })

  test('tetap: tidak ada cookie yang ditulis', () => {
    expect(
      cookieHeader(applySession(NextResponse.json({}), { kind: 'keep' }, { secure: true })),
    ).toBe('')
  })

  test('membaca sesi dari cookie', () => {
    const jar = new Map([[ACCESS_COOKIE, { value: 'a' }]])

    expect(sessionFrom({ get: (name) => jar.get(name) })).toEqual({
      accessToken: 'a',
      refreshToken: undefined,
    })
  })
})
