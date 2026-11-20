import { describe, expect, test } from 'vitest'
import { TOKENS, failed, ok, scriptedGateway } from '@/testing/fakes'
import { forwardToOps, isSameOrigin, opsPath, refresh } from './ops-proxy'

const SESSION = { accessToken: 'akses-lama', refreshToken: 'segar-lama' }

describe('opsPath — hanya di bawah /ops', () => {
  test('segmen biasa disambung di bawah /ops', () => {
    expect(opsPath(['suppliers', 'requests'])).toBe('/ops/suppliers/requests')
  })

  test('penelusuran ke luar /ops dan segmen aneh ditolak', () => {
    for (const segments of [
      [],
      ['..', 'auth', 'me'],
      ['.'],
      ['suppliers', '..'],
      ['a b'],
      ['a%2Fb'],
    ]) {
      expect(opsPath(segments)).toBeUndefined()
    }
  })
})

describe('forwardToOps', () => {
  test('jalur tidak sah: 400 tanpa menyentuh gateway', async () => {
    const gateway = scriptedGateway({})

    const result = await forwardToOps(gateway, {
      method: 'GET',
      segments: ['..', 'auth', 'me'],
      search: '',
      tokens: SESSION,
    })

    expect(result.status).toBe(400)
    expect(gateway.calls).toEqual([])
  })

  test('tanpa sesi: 401 tanpa menyentuh gateway', async () => {
    const gateway = scriptedGateway({})

    const result = await forwardToOps(gateway, {
      method: 'GET',
      segments: ['suppliers'],
      search: '',
      tokens: {},
    })

    expect(result.status).toBe(401)
    expect(gateway.calls).toEqual([])
  })

  test('diteruskan dengan access token, kueri, dan badan apa adanya', async () => {
    const gateway = scriptedGateway({ 'PATCH /ops/suppliers/SKY?x=1': ok({ code: 'SKY' }) })

    const result = await forwardToOps(gateway, {
      method: 'PATCH',
      segments: ['suppliers', 'SKY'],
      search: '?x=1',
      body: { isActive: false },
      tokens: SESSION,
    })

    expect(result).toMatchObject({ status: 200, session: { kind: 'keep' } })
    expect(gateway.calls).toEqual([
      {
        method: 'PATCH',
        path: '/ops/suppliers/SKY?x=1',
        body: { isActive: false },
        accessToken: 'akses-lama',
      },
    ])
  })

  test('401: disegarkan SEKALI lalu diulang dengan token baru', async () => {
    const gateway = scriptedGateway({
      'GET /ops/suppliers': [failed(401), ok([])],
      'POST /auth/refresh': ok(TOKENS),
    })

    const result = await forwardToOps(gateway, {
      method: 'GET',
      segments: ['suppliers'],
      search: '',
      tokens: SESSION,
    })

    expect(result).toMatchObject({ status: 200, session: { kind: 'renewed', tokens: TOKENS } })
    expect(gateway.calls.map((call) => call.accessToken)).toEqual([
      'akses-lama',
      undefined,
      'akses-baru',
    ])
  })

  test('access token tidak ada, refresh ada: langsung disegarkan setelah 401', async () => {
    const gateway = scriptedGateway({
      'GET /ops/suppliers': [failed(401), ok([])],
      'POST /auth/refresh': ok(TOKENS),
    })

    const result = await forwardToOps(gateway, {
      method: 'GET',
      segments: ['suppliers'],
      search: '',
      tokens: { refreshToken: 'segar-lama' },
    })

    expect(result.session.kind).toBe('renewed')
  })

  test('penyegaran gagal: 401 dan sesi DIHAPUS', async () => {
    const gateway = scriptedGateway({
      'GET /ops/suppliers': failed(401),
      'POST /auth/refresh': failed(401),
    })

    const result = await forwardToOps(gateway, {
      method: 'GET',
      segments: ['suppliers'],
      search: '',
      tokens: SESSION,
    })

    expect(result).toMatchObject({ status: 401, session: { kind: 'clear' } })
  })

  test('403 (peran dicabut) diteruskan, TANPA penyegaran — token baru membawa peran yang sama', async () => {
    const gateway = scriptedGateway({ 'GET /ops/suppliers': failed(403, 'FORBIDDEN') })

    const result = await forwardToOps(gateway, {
      method: 'GET',
      segments: ['suppliers'],
      search: '',
      tokens: SESSION,
    })

    expect(result.status).toBe(403)
    expect(gateway.calls).toHaveLength(1)
  })
})

describe('refresh', () => {
  test('tanpa refresh token, atau jawaban berbentuk lain: tidak ada token', async () => {
    expect(await refresh(scriptedGateway({}), undefined)).toBeUndefined()
    expect(
      await refresh(scriptedGateway({ 'POST /auth/refresh': ok({ accessToken: 'x' }) }), 'r'),
    ).toBeUndefined()
  })
})

describe('isSameOrigin', () => {
  const URL_ = 'https://ops.lintang.internal/api/ops/suppliers'

  test('GET selalu boleh; penulisan hanya dari asal yang sama', () => {
    expect(isSameOrigin('GET', null, URL_)).toBe(true)
    expect(isSameOrigin('POST', 'https://ops.lintang.internal', URL_)).toBe(true)
    expect(isSameOrigin('PATCH', 'https://jahat.example', URL_)).toBe(false)
    expect(isSameOrigin('DELETE', null, URL_)).toBe(false)
  })
})
