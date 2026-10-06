import { createLogger } from '@tbe/shared-kernel'
import { Redis } from 'ioredis'
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { expiryListener } from '../../src/infrastructure/keyspace-expiry.js'
import {
  createRedisHoldStore,
  SLOT_CAPACITY_TTL_MS,
} from '../../src/infrastructure/redis-hold-store.js'
import { integrationEnv } from './env.js'

/**
 * Hold lokal terhadap Redis SUNGGUHAN.
 *
 * Uji unit membuktikan kode kita bergantung pada atomisitas; uji ini
 * membuktikan Redis memberikannya — dan bahwa tanpa skrip Lua, Redis yang sama
 * menjual lebih dari yang ada.
 */

const { redisUrl } = integrationEnv()
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null })
const store = createRedisHoldStore(redis)
const SLOT = 'SKY|SKY-RP-DLX-BB|2026-11-10|2026-11-12'
const ids = (count: number) =>
  Array.from({ length: count }, (_, index) => `booking-${String(index)}`)
const future = () => new Date(Date.now() + 60_000)

beforeEach(async () => {
  await redis.flushdb()
})

afterAll(async () => {
  await redis.quit()
})

describe('US-04 terhadap Redis sungguhan', () => {
  test('seratus pengambilan serentak untuk kapasitas sepuluh: tepat sepuluh', async () => {
    const outcomes = await Promise.all(
      ids(100).map(
        async (bookingId) =>
          await store.acquire({ bookingId, slot: SLOT, capacity: 10, until: future() }),
      ),
    )

    expect(outcomes.filter((outcome) => outcome === 'held')).toHaveLength(10)
    expect(outcomes.filter((outcome) => outcome === 'sold_out')).toHaveLength(90)
    expect(await redis.scard(`booking:hold:members:${SLOT}`)).toBe(10)
  })

  /**
   * Uji di atas tidak hampa. Logika yang SAMA — baca jumlah kursi, bandingkan,
   * tambah anggota — tetapi sebagai perintah terpisah dari klien, bukan satu
   * skrip. Seratus klien serentak membaca jumlah yang sama sebelum ada yang
   * menambah, dan Redis yang sama menjual lebih dari sepuluh.
   */
  test('uji tidak hampa: baca-lalu-tulis dari klien menjual lebih dari sepuluh', async () => {
    const clients = await Promise.all(
      ids(20).map(async () => {
        const client = new Redis(redisUrl, { maxRetriesPerRequest: null })
        await client.ping()
        return client
      }),
    )

    try {
      const outcomes = await Promise.all(
        ids(100).map(async (bookingId, index) => {
          const client = clients[index % clients.length] ?? redis
          const taken = await client.scard(`booking:hold:members:${SLOT}`)
          if (taken >= 10) return 'sold_out'
          await client.sadd(`booking:hold:members:${SLOT}`, bookingId)
          return 'held'
        }),
      )

      expect(outcomes.filter((outcome) => outcome === 'held').length).toBeGreaterThan(10)
    } finally {
      await Promise.all(clients.map(async (client) => await client.quit()))
    }
  })

  test('pengambilan ulang untuk pemesanan yang sama tidak memakai kursi kedua', async () => {
    const claim = { bookingId: 'booking-1', slot: SLOT, capacity: 2, until: future() }

    expect(await store.acquire(claim)).toBe('held')
    expect(await store.acquire(claim)).toBe('already_held')
    expect(await redis.scard(`booking:hold:members:${SLOT}`)).toBe(1)
  })

  test('kapasitas slot ditetapkan sekali, dengan umur, dan tidak dapat dinaikkan', async () => {
    await store.acquire({ bookingId: 'a', slot: SLOT, capacity: 1, until: future() })

    expect(await store.acquire({ bookingId: 'b', slot: SLOT, capacity: 99, until: future() })).toBe(
      'sold_out',
    )
    const ttl = await redis.pttl(`booking:hold:cap:${SLOT}`)
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(SLOT_CAPACITY_TTL_MS)
  })
})

describe('pelepasan', () => {
  test('dua pelepasan serentak: tepat satu yang mengembalikan kursi', async () => {
    await store.acquire({ bookingId: 'booking-1', slot: SLOT, capacity: 1, until: future() })

    const released = await Promise.all([
      store.release({ bookingId: 'booking-1', slot: SLOT }),
      store.release({ bookingId: 'booking-1', slot: SLOT }),
    ])

    expect(released.sort()).toEqual([false, true])
    expect(
      await store.acquire({ bookingId: 'booking-2', slot: SLOT, capacity: 1, until: future() }),
    ).toBe('held')
  })

  test('kunci waktu dapat dimajukan, tidak dapat dimundurkan', async () => {
    const until = new Date(Date.now() + 60_000)
    await store.acquire({ bookingId: 'booking-1', slot: SLOT, capacity: 1, until })

    await store.shorten('booking-1', new Date(Date.now() + 10_000))
    const shortened = await redis.pttl('booking:hold:lock:booking-1')
    await store.shorten('booking-1', new Date(Date.now() + 120_000))
    const after = await redis.pttl('booking:hold:lock:booking-1')

    expect(shortened).toBeLessThanOrEqual(10_000)
    expect(after).toBeLessThanOrEqual(10_000)
  })

  test('kursi yang kunci waktunya kedaluwarsa terlihat sebagai yatim', async () => {
    await store.acquire({
      bookingId: 'booking-1',
      slot: SLOT,
      capacity: 2,
      until: new Date(Date.now() + 50),
    })
    await store.acquire({ bookingId: 'booking-2', slot: SLOT, capacity: 2, until: future() })

    await vi.waitFor(
      async () => {
        expect(await store.orphans(10)).toEqual([{ bookingId: 'booking-1', slot: SLOT }])
      },
      { timeout: 5_000, interval: 25 },
    )
  })
})

describe('keyspace notification', () => {
  test('kedaluwarsa kunci waktu memanggil pendengar dengan pengenal pemesanannya', async () => {
    const subscriber = new Redis(redisUrl, { maxRetriesPerRequest: null })
    const expired: string[] = []
    const listener = expiryListener({
      subscriber,
      commands: redis,
      database: redis.options.db ?? 0,
      logger: createLogger({ serviceName: 'it', level: 'silent' }),
      onExpired: async (bookingId) => {
        expired.push(bookingId)
        await Promise.resolve()
      },
    })

    try {
      await listener.start?.()
      await store.acquire({
        bookingId: 'booking-kedaluwarsa',
        slot: SLOT,
        capacity: 1,
        until: new Date(Date.now() + 100),
      })
      // Kunci milik service lain di kanal yang sama tidak boleh diteruskan.
      await redis.set('search:cache:x', '1', 'PX', 50)

      await vi.waitFor(
        () => {
          expect(expired).toEqual(['booking-kedaluwarsa'])
        },
        { timeout: 5_000, interval: 50 },
      )
    } finally {
      await listener.stop()
      await subscriber.quit()
    }
  })

  test('Redis tanpa notifikasi kedaluwarsa dicatat saat startup', async () => {
    const [, original] = (await redis.config('GET', 'notify-keyspace-events')) as [string, string]
    const subscriber = new Redis(redisUrl, { maxRetriesPerRequest: null })
    const logger = createLogger({ serviceName: 'it', level: 'silent' })
    const warn = vi.spyOn(logger, 'warn')

    try {
      await redis.config('SET', 'notify-keyspace-events', '')
      const listener = expiryListener({
        subscriber,
        commands: redis,
        database: 0,
        logger,
        onExpired: async () => {
          await Promise.resolve()
        },
      })
      await listener.start?.()
      await listener.stop()

      expect(warn).toHaveBeenCalledWith(
        { flags: '' },
        expect.stringContaining('hanya dilepas oleh penyapu'),
      )
    } finally {
      await redis.config('SET', 'notify-keyspace-events', original)
      await subscriber.quit()
    }
  })
})
