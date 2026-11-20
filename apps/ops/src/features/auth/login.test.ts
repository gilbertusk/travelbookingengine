import { describe, expect, test } from 'vitest'
import { TOKENS, failed, ok, scriptedGateway } from '@/testing/fakes'
import { loginOperator } from './login'

const CREDENTIALS = { email: 'sari@example.com', password: 'rahasia-panjang' }
const user = (role: string) => ({ email: CREDENTIALS.email, name: 'Sari', role })

describe('loginOperator', () => {
  test('operator: masuk, dengan token dari auth-service', async () => {
    const gateway = scriptedGateway({
      'POST /auth/login': ok({ user: user('operator'), ...TOKENS }),
    })

    expect(await loginOperator(gateway, CREDENTIALS)).toEqual({
      kind: 'signed_in',
      tokens: TOKENS,
      name: 'Sari',
    })
  })

  test('pelanggan yang sah: ditolak, dan sesinya langsung dicabut', async () => {
    const gateway = scriptedGateway({
      'POST /auth/login': ok({ user: user('customer'), ...TOKENS }),
      'POST /auth/logout': ok({}),
    })

    expect(await loginOperator(gateway, CREDENTIALS)).toEqual({ kind: 'not_operator' })
    expect(gateway.calls[1]).toEqual({
      method: 'POST',
      path: '/auth/logout',
      body: { refreshToken: TOKENS.refreshToken },
    })
  })

  test('kredensial salah: status dan badan gateway diteruskan apa adanya', async () => {
    const gateway = scriptedGateway({ 'POST /auth/login': failed(401, 'INVALID_CREDENTIALS') })

    expect(await loginOperator(gateway, CREDENTIALS)).toMatchObject({
      kind: 'rejected',
      status: 401,
    })
  })

  test('200 dengan bentuk yang tidak dikenal: 502, bukan masuk', async () => {
    const gateway = scriptedGateway({ 'POST /auth/login': ok({ token: 'x' }) })

    expect(await loginOperator(gateway, CREDENTIALS)).toMatchObject({
      kind: 'rejected',
      status: 502,
    })
  })
})
