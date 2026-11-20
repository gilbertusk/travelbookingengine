import { describe, expect, test, vi } from 'vitest'
import { z } from 'zod'
import { envelope, fakeFetch } from '@/testing/render'
import { OpsError, opsRequest } from './ops-client'

const schema = z.object({ code: z.string() })

describe('opsRequest', () => {
  test('memanggil rute server panel, bukan gateway, dan mengurai amplop', async () => {
    const { calls } = fakeFetch({ 'GET /api/ops/suppliers': envelope({ code: 'SKY' }) })

    expect(await opsRequest(schema, 'GET', '/suppliers')).toEqual({ code: 'SKY' })
    expect(calls[0]?.url).toBe('/api/ops/suppliers')
  })

  test('badan dikirim sebagai JSON', async () => {
    const { calls } = fakeFetch({ 'PATCH /api/ops/suppliers/SKY': envelope({ code: 'SKY' }) })

    await opsRequest(schema, 'PATCH', '/suppliers/SKY', { body: { isActive: false } })

    expect(calls[0]?.body).toEqual({ isActive: false })
  })

  test('jawaban mentah tanpa amplop (mock supplier)', async () => {
    fakeFetch({ 'GET /api/ops/mock-supplier/state': { body: { code: 'SKY' } } })

    expect(await opsRequest(schema, 'GET', '/mock-supplier/state', { isEnveloped: false })).toEqual(
      {
        code: 'SKY',
      },
    )
  })

  test('bentuk yang tidak dikenal ditolak, bukan ditampilkan kosong', async () => {
    fakeFetch({ 'GET /api/ops/x': envelope({ kode: 'SKY' }) })

    await expect(opsRequest(schema, 'GET', '/x')).rejects.toMatchObject({
      code: 'UNEXPECTED_SHAPE',
    })
  })

  test('galat membawa kode dan pesan service; 401 mengarahkan ke halaman masuk', async () => {
    fakeFetch({
      'GET /api/ops/a': {
        status: 403,
        body: { data: null, error: { code: 'FORBIDDEN', message: 'Bukan operator' } },
      },
      'GET /api/ops/b': { status: 401, body: null },
    })
    const navigator = { toLogin: vi.fn() }

    await expect(opsRequest(schema, 'GET', '/a', { navigator })).rejects.toEqual(
      new OpsError(403, 'FORBIDDEN', 'Bukan operator'),
    )
    await expect(opsRequest(schema, 'GET', '/b', { navigator })).rejects.toMatchObject({
      status: 401,
      code: 'UNKNOWN',
      message: 'Permintaan gagal.',
    })
    expect(navigator.toLogin).toHaveBeenCalledTimes(1)
  })
})
