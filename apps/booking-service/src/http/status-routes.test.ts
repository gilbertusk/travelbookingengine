import express, { type Express } from 'express'
import request from 'supertest'
import { describe, expect, test } from 'vitest'
import { createBookingHttpApp } from '../composition/app.js'
import { OTHER_USER, USER } from '../testing/fakes.js'
import { sagaWorld, type SagaWorld } from '../testing/saga-world.js'
import { get } from 'node:http'
import { identity, USER_ID_HEADER } from './identity.js'

/**
 * Antarmuka status (Step 19): GET /bookings/:id/status dan aliran SSE di
 * /bookings/stream/:id, yang dipakai layar tunggu Step 21.
 */

function app(world: SagaWorld, heartbeatMs = 60_000): Express {
  return createBookingHttpApp({
    deps: world.deps,
    logger: world.deps.logger,
    serviceName: 'booking-service-test',
    statusStream: { pollMs: 5, heartbeatMs },
  }).app
}

/** Seluruh badan aliran SSE sebagai teks, sampai server menutupnya. */
async function streamText(target: Express, bookingId: string, user = USER): Promise<string> {
  const response = await request(target)
    .get(`/bookings/stream/${bookingId}`)
    .set(USER_ID_HEADER, user)
    .buffer(true)
    .parse((res, done) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        text += chunk
      })
      res.on('end', () => {
        done(null, text)
      })
    })

  expect(response.headers['content-type']).toContain('text/event-stream')
  return String(response.body)
}

function statuses(text: string): string[] {
  return text
    .split('\n\n')
    .filter((block) => block.startsWith('event: status'))
    .map((block) => {
      const data = block.split('\n').find((line) => line.startsWith('data: '))
      const parsed: unknown = JSON.parse(data?.slice('data: '.length) ?? '{}')
      return typeof parsed === 'object' && parsed !== null && 'status' in parsed
        ? String(parsed.status)
        : ''
    })
}

/**
 * Aliran SSE yang dibaca sambil berjalan, lewat server sungguhan. Uji dapat
 * menunggu sampai sesuatu BENAR-BENAR tiba di klien sebelum mengubah keadaan —
 * menunggu dengan jam dinding gagal di bawah beban `pnpm test`.
 */
function openStream(target: Express, bookingId: string) {
  const server = target.listen(0)
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  let text = ''
  const ended = new Promise<void>((resolve) => {
    get(
      { port, path: `/bookings/stream/${bookingId}`, headers: { [USER_ID_HEADER]: USER } },
      (response) => {
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          text += chunk
        })
        response.on('end', () => {
          resolve()
        })
      },
    )
  })

  return {
    text: () => text,
    until: async (condition: (text: string) => boolean): Promise<void> => {
      while (!condition(text)) await new Promise((resolve) => setTimeout(resolve, 5))
    },
    finished: async (): Promise<string> => {
      await ended
      server.close()
      return text
    },
  }
}

describe('GET /bookings/:id/status', () => {
  test('pemesanan yang menunggu supplier: status, fase saga, dan tanpa refund', async () => {
    const world = sagaWorld()
    const paid = await world.paid()

    const response = await request(app(world))
      .get(`/bookings/${paid.id}/status`)
      .set(USER_ID_HEADER, USER)

    expect(response.status).toBe(200)
    expect(response.body.data).toMatchObject({
      id: paid.id,
      status: 'PAID',
      isFinal: false,
      refund: null,
      saga: { phase: 'running', step: 'confirmSupplier' },
    })
  })

  test('FR-23: pemesanan gagal membawa alasan dan status pengembalian dananya', async () => {
    const world = sagaWorld()
    const paid = await world.paid()
    await world.supplierRejected(paid)

    const pending = await request(app(world))
      .get(`/bookings/${paid.id}/status`)
      .set(USER_ID_HEADER, USER)
    await world.paymentRefunded(paid)
    const done = await request(app(world))
      .get(`/bookings/${paid.id}/status`)
      .set(USER_ID_HEADER, USER)

    expect(pending.body.data).toMatchObject({
      refund: 'pending',
      failureReason: expect.stringContaining('sold_out'),
    })
    expect(done.body.data).toMatchObject({ status: 'REFUNDED', isFinal: true, refund: 'completed' })
  })

  test('peninjauan manusia terlihat sebagai status pengembalian dana "review"', async () => {
    const world = sagaWorld()
    const paid = await world.paid()
    await world.supplierUncertain(paid)

    const response = await request(app(world))
      .get(`/bookings/${paid.id}/status`)
      .set(USER_ID_HEADER, USER)

    expect(response.body.data).toMatchObject({ status: 'NEEDS_REVIEW', refund: 'review' })
  })

  test('pemesanan yang belum pernah di-hold: tanpa saga', async () => {
    const world = sagaWorld()
    const held = await world.held()
    world.db.committed().sagas.delete(held.id)

    const response = await request(app(world))
      .get(`/bookings/${held.id}/status`)
      .set(USER_ID_HEADER, USER)

    expect(response.body.data).toMatchObject({ saga: null })
  })

  test('pemesanan orang lain dijawab seperti pemesanan yang tidak ada', async () => {
    const world = sagaWorld()
    const held = await world.held()

    const response = await request(app(world))
      .get(`/bookings/${held.id}/status`)
      .set(USER_ID_HEADER, OTHER_USER)

    expect(response.status).toBe(404)
  })
})

describe('GET /bookings/stream/:id (SSE)', () => {
  test('pemesanan yang sudah tuntas: satu status, lalu aliran ditutup', async () => {
    const world = sagaWorld()
    const paid = await world.paid()
    await world.supplierConfirmed(paid)

    const text = await streamText(app(world), paid.id)

    expect(statuses(text)).toEqual(['CONFIRMED'])
    expect(text).toContain('event: end')
  })

  test('pemesanan tanpa saga yang sudah final: satu status tanpa saga', async () => {
    const world = sagaWorld()
    world.suppliers.nextPrice({ kind: 'rejected', reason: 'sold_out' })
    await world.held().catch(() => undefined)
    const [cancelled] = [...world.db.committed().bookings.keys()]
    if (cancelled === undefined) throw new Error('persiapan gagal')

    const text = await streamText(app(world), cancelled)

    expect(statuses(text)).toEqual(['CANCELLED'])
    expect(text).toContain('"saga":null')
  })

  /**
   * Deterministik: perubahan berikutnya baru dibuat SETELAH status sebelumnya
   * benar-benar tiba di klien. Versi pertama menunggu 30 ms dengan jam dinding
   * dan gagal di bawah beban `pnpm test` — status PAID belum terbaca saat
   * pemesanan sudah FAILED, dan aliran (dengan benar) hanya memancarkan
   * keadaan yang dilihatnya.
   */
  test('memancarkan setiap perubahan status sampai pemesanan tuntas', async () => {
    const world = sagaWorld()
    const paid = await world.paid()
    const stream = openStream(app(world), paid.id)

    await stream.until((text) => statuses(text).includes('PAID'))
    await world.supplierRejected(paid)
    await stream.until((text) => statuses(text).includes('FAILED'))
    await world.paymentRefunded(paid)

    expect(statuses(await stream.finished())).toEqual(['PAID', 'FAILED', 'REFUNDED'])
  })

  test('komentar penjaga koneksi terkirim selama menunggu', async () => {
    const world = sagaWorld()
    const paid = await world.paid()
    const stream = openStream(app(world, 5), paid.id)

    await stream.until((text) => text.includes(': tetap tersambung'))
    await world.supplierConfirmed(paid)

    expect(statuses(await stream.finished())).toEqual(['PAID', 'CONFIRMED'])
  })

  test('pemesanan orang lain: 404 JSON, aliran tidak pernah dibuka', async () => {
    const world = sagaWorld()
    const held = await world.held()

    const response = await request(app(world))
      .get(`/bookings/stream/${held.id}`)
      .set(USER_ID_HEADER, OTHER_USER)

    expect(response.status).toBe(404)
    expect(response.headers['content-type']).toContain('application/json')
  })
})

describe('aliran yang terputus', () => {
  test('galat di tengah aliran: dicatat tingkat error dan aliran ditutup', async () => {
    const world = sagaWorld()
    const paid = await world.paid()
    let reads = 0
    const real = world.deps.bookings
    const failing = {
      ...world.deps,
      bookings: {
        ...world.deps.bookings,
        findById: async (id: string) => {
          reads += 1
          if (reads > 2) throw new Error('basis data putus')
          return await real.findById(id)
        },
      },
    }
    const target = createBookingHttpApp({
      deps: failing,
      logger: world.deps.logger,
      serviceName: 'booking-service-test',
      statusStream: { pollMs: 5, heartbeatMs: 60_000 },
    }).app

    const text = await streamText(target, paid.id)

    expect(statuses(text)).toEqual(['PAID'])
    expect(text).not.toContain('event: end')
    expect(world.logs().some((entry) => entry.msg === 'aliran status gagal')).toBe(true)
  })

  test('penonton yang menutup koneksi menghentikan pembacaan', async () => {
    const world = sagaWorld()
    const paid = await world.paid()
    let reads = 0
    const real = world.deps.bookings
    const counting = {
      ...world.deps,
      bookings: {
        ...world.deps.bookings,
        findById: async (id: string) => {
          reads += 1
          return await real.findById(id)
        },
      },
    }
    const server = createBookingHttpApp({
      deps: counting,
      logger: world.deps.logger,
      serviceName: 'booking-service-test',
      statusStream: { pollMs: 5, heartbeatMs: 60_000 },
    }).app.listen(0)
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0

    await new Promise<void>((resolve) => {
      const call = get(
        { port, path: `/bookings/stream/${paid.id}`, headers: { [USER_ID_HEADER]: USER } },
        (response) => {
          response.once('data', () => {
            call.destroy()
            resolve()
          })
        },
      )
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const afterClose = reads
    await new Promise((resolve) => setTimeout(resolve, 50))
    server.close()

    expect(reads).toBe(afterClose)
  })
})

describe('identitas', () => {
  test('membaca identitas tanpa middleware-nya adalah cacat perangkaian', async () => {
    const bare = express()
    let failure: unknown
    bare.get('/tanpa-identitas', (_req, res) => {
      try {
        identity.value(res)
      } catch (error) {
        failure = error
      }
      res.end()
    })

    await request(bare).get('/tanpa-identitas')

    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toContain('tidak dipasang')
  })
})
