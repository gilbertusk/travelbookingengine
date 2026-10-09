import { createLogger } from '@tbe/shared-kernel'
import { Redis } from 'ioredis'
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { expireHold } from '../../src/application/expire-hold.js'
import { placeHold, slotOf } from '../../src/application/place-hold.js'
import type { BookingDeps } from '../../src/application/ports.js'
import { startPriceCheck } from '../../src/application/price-check.js'
import { sweepHolds } from '../../src/application/sweep-holds.js'
import type { Booking } from '../../src/domain/booking.js'
import { expiryListener } from '../../src/infrastructure/keyspace-expiry.js'
import { createPrismaBookingRepository } from '../../src/infrastructure/prisma-booking-repository.js'
import { createPrismaSagaStore } from '../../src/infrastructure/prisma-saga-store.js'
import { bookingDbOf, createPrismaClient } from '../../src/infrastructure/prisma-client.js'
import { createRedisHoldStore } from '../../src/infrastructure/redis-hold-store.js'
import { systemClock } from '../../src/infrastructure/system.js'
import {
  priceCheckRequest,
  SAGA_POLICY,
  scriptedPricing,
  scriptedProperties,
  scriptedSuppliers,
} from '../../src/testing/fakes.js'
import { integrationEnv } from './env.js'

/**
 * Alur hold ujung ke ujung: use case sungguhan, Postgres sungguhan, Redis
 * sungguhan, jam sungguhan. Yang dipalsukan hanya supplier-service dan
 * pricing-service — keduanya service lain, dengan uji sendiri.
 */

const { databaseUrl, redisUrl } = integrationEnv()
const prisma = createPrismaClient(databaseUrl)
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null })
const logger = createLogger({ serviceName: 'it', level: 'silent' })

function deps(holdDurationMs: number): BookingDeps {
  return {
    bookings: createPrismaBookingRepository(bookingDbOf(prisma)),
    sagas: createPrismaSagaStore(bookingDbOf(prisma)),
    sagaPolicy: SAGA_POLICY,
    suppliers: scriptedSuppliers(() => new Date()),
    pricing: scriptedPricing(),
    properties: scriptedProperties(),
    holds: createRedisHoldStore(redis),
    clock: systemClock,
    ids: { next: () => crypto.randomUUID() },
    holdPolicy: { durationMs: holdDurationMs, sweepBatch: 200 },
    logger,
  }
}

async function verified(world: BookingDeps, userId: string, key: string): Promise<Booking> {
  const result = await startPriceCheck(world, priceCheckRequest({ userId, key }))
  if (result.kind !== 'checked') throw new Error(`persiapan gagal: ${result.kind}`)
  return result.booking
}

function booking0(bookings: readonly Booking[]): Booking {
  const [first] = bookings
  if (first === undefined) throw new Error('tidak ada pemesanan')
  return first
}

beforeEach(async () => {
  await redis.flushdb()
})

afterAll(async () => {
  await redis.quit()
  await prisma.$disconnect()
})

describe('US-04 ujung ke ujung', () => {
  test('seratus hold serentak untuk ketersediaan sepuluh: tepat sepuluh HELD di Postgres', async () => {
    const world = deps(60_000)
    const userId = crypto.randomUUID()
    const bookings = await Promise.all(
      Array.from(
        { length: 100 },
        async (_, index) =>
          await verified(world, userId, `req-e2e-us04-${String(index).padStart(6, '0')}`),
      ),
    )

    const results = await Promise.all(
      bookings.map(
        async (booking) => await placeHold(world, { userId, bookingId: booking.id, unitsLeft: 10 }),
      ),
    )

    expect(results.filter((result) => result.kind === 'held')).toHaveLength(10)
    expect(results.filter((result) => result.kind === 'sold_out')).toHaveLength(90)
    expect(await prisma.booking.count({ where: { userId, status: 'HELD' } })).toBe(10)
    expect(new Set(bookings.map(slotOf)).size).toBe(1)
    expect(await redis.scard(`booking:hold:members:${slotOf(booking0(bookings))}`)).toBe(10)
  })
})

describe('pelepasan otomatis ujung ke ujung (FR-16)', () => {
  test('lewat keyspace notification: EXPIRED di Postgres, kursi kembali di Redis, tanpa penyapu', async () => {
    const world = deps(300)
    const userId = crypto.randomUUID()
    const booking = await verified(world, userId, 'req-e2e-keyspace-0001')
    const subscriber = new Redis(redisUrl, { maxRetriesPerRequest: null })
    const listener = expiryListener({
      subscriber,
      commands: redis,
      database: redis.options.db ?? 0,
      logger,
      onExpired: async (bookingId) => {
        await expireHold(world, bookingId)
      },
    })

    try {
      await listener.start?.()
      const held = await placeHold(world, { userId, bookingId: booking.id, unitsLeft: 1 })
      expect(held.kind).toBe('held')

      await vi.waitFor(
        async () => {
          expect((await world.bookings.findById(booking.id))?.status).toBe('EXPIRED')
        },
        { timeout: 5_000, interval: 50 },
      )
      expect(await redis.scard(`booking:hold:members:${slotOf(booking)}`)).toBe(0)
    } finally {
      await listener.stop()
      await subscriber.quit()
    }
  })

  test('notifikasi hilang: penyapu melepaskan, dan penyapu serentak dengan keyspace tidak menggandakan', async () => {
    const world = deps(100)
    const userId = crypto.randomUUID()
    const booking = await verified(world, userId, 'req-e2e-sweeper-0001')
    await placeHold(world, { userId, bookingId: booking.id, unitsLeft: 1 })
    await vi.waitFor(
      async () => {
        const due = await world.bookings.findExpiredHolds(new Date(), 1_000)
        expect(due.map((held) => held.id)).toContain(booking.id)
      },
      { timeout: 5_000, interval: 25 },
    )

    // Tidak ada pendengar: notifikasinya hilang. Penyapu dan satu panggilan
    // "keyspace" yang terlambat berjalan bersamaan.
    const [, late] = await Promise.all([sweepHolds(world), expireHold(world, booking.id)])

    expect((await world.bookings.findById(booking.id))?.status).toBe('EXPIRED')
    // Penyapu menyapu SEMUA hold yang lewat di basis data bersama, jadi angka
    // di laporannya bukan milik uji ini — versi sebelumnya membandingkannya
    // dengan 1, dan CI pertama (urutan berkas berbeda) melihat 6. Yang
    // membuktikan "tidak menggandakan" adalah jejaknya: tepat satu HoldExpired.
    expect(['expired', 'already_moved']).toContain(late)
    expect(
      await prisma.bookingEvent.count({
        where: { bookingId: booking.id, eventType: 'HoldExpired' },
      }),
    ).toBe(1)
    expect(await redis.scard(`booking:hold:members:${slotOf(booking)}`)).toBe(0)
  })
})
