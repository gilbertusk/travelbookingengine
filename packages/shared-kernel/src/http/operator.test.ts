import type { Express } from 'express'
import request from 'supertest'
import { describe, expect, test } from 'vitest'
import { createLogger } from '../logger/logger.js'
import { success } from './envelope.js'
import { USER_ID_HEADER, USER_ROLE_HEADER, isUserRole, requireOperator } from './operator.js'
import { createHttpServer, finalizeHttpServer } from './server.js'

const silentLogger = (): ReturnType<typeof createLogger> =>
  createLogger({
    serviceName: 'uji',
    level: 'silent',
    destination: {
      write(): void {
        // keluaran log tidak diuji di berkas ini
      },
    },
  })

function buildApp(): Express {
  const app = createHttpServer({ logger: silentLogger() })
  app.get('/ops/rahasia', requireOperator, (_req, res) => {
    res.json(success({ isi: 'panel' }))
  })
  finalizeHttpServer(app, silentLogger())
  return app
}

const USER = '0190f4c2-0000-7000-8000-000000000001'

describe('requireOperator', () => {
  test('tanpa identitas gateway: 401, bukan 403', async () => {
    const response = await request(buildApp()).get('/ops/rahasia')

    expect(response.status).toBe(401)
  })

  test('identitas kosong diperlakukan sama dengan tidak ada', async () => {
    const response = await request(buildApp()).get('/ops/rahasia').set(USER_ID_HEADER, '')

    expect(response.status).toBe(401)
  })

  test('pelanggan yang sah tetap ditolak 403', async () => {
    const response = await request(buildApp())
      .get('/ops/rahasia')
      .set(USER_ID_HEADER, USER)
      .set(USER_ROLE_HEADER, 'customer')

    expect(response.status).toBe(403)
    expect(response.body.error.code).toBe('FORBIDDEN')
  })

  test('identitas tanpa peran ditolak 403 — tidak ada peran bawaan "operator"', async () => {
    const response = await request(buildApp()).get('/ops/rahasia').set(USER_ID_HEADER, USER)

    expect(response.status).toBe(403)
  })

  test('peran dicocokkan persis, bukan tanpa huruf besar-kecil', async () => {
    const response = await request(buildApp())
      .get('/ops/rahasia')
      .set(USER_ID_HEADER, USER)
      .set(USER_ROLE_HEADER, 'OPERATOR')

    expect(response.status).toBe(403)
  })

  test('operator diteruskan ke handler', async () => {
    const response = await request(buildApp())
      .get('/ops/rahasia')
      .set(USER_ID_HEADER, USER)
      .set(USER_ROLE_HEADER, 'operator')

    expect(response.status).toBe(200)
    expect(response.body.data).toEqual({ isi: 'panel' })
  })
})

describe('isUserRole', () => {
  test('hanya dua peran yang dikenal', () => {
    expect(isUserRole('customer')).toBe(true)
    expect(isUserRole('operator')).toBe(true)
    expect(isUserRole('admin')).toBe(false)
    expect(isUserRole(undefined)).toBe(false)
  })
})
