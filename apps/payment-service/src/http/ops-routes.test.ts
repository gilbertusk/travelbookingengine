import { USER_ID_HEADER, USER_ROLE_HEADER } from '@tbe/shared-kernel'
import request from 'supertest'
import { describe, expect, test } from 'vitest'
import { createPaymentHttpApp } from '../composition/app.js'
import { TEST_PAYMENT_ID, givenSucceededPayment, harness, type Harness } from '../testing/fakes.js'

function app(world: Harness) {
  return createPaymentHttpApp({
    deps: world.deps,
    limiter: {
      consume: async () =>
        await Promise.resolve({ allowed: true, limit: 1, remaining: 1, resetAfterSeconds: 60 }),
    },
    logger: world.deps.logger,
    serviceName: 'payment-service-test',
  }).app
}

const PATH = `/ops/payments/${TEST_PAYMENT_ID}`

describe('GET /ops/payments/:id', () => {
  test('tanpa identitas 401, pelanggan 403', async () => {
    const world = harness()
    await givenSucceededPayment(world)

    expect((await request(app(world)).get(PATH)).status).toBe(401)
    const customer = await request(app(world))
      .get(PATH)
      .set(USER_ID_HEADER, 'user-1')
      .set(USER_ROLE_HEADER, 'customer')
    expect(customer.status).toBe(403)
  })

  test('operator melihat status pembayaran yang sama dengan jawaban internal', async () => {
    const world = harness()
    await givenSucceededPayment(world)

    const ops = await request(app(world))
      .get(PATH)
      .set(USER_ID_HEADER, 'user-ops')
      .set(USER_ROLE_HEADER, 'operator')
    const internal = await request(app(world)).get(`/internal/payments/${TEST_PAYMENT_ID}`)

    expect(ops.status).toBe(200)
    expect(ops.body.data).toEqual(internal.body.data)
    expect(ops.body.data.payment.status).toBe('SUCCEEDED')
  })
})
