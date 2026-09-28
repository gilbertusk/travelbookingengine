import pg from 'pg'
import { createLogger, ValidationError } from '@tbe/shared-kernel'
import { afterAll, describe, expect, test } from 'vitest'
import { createPrismaBookingRepository } from '../../src/infrastructure/prisma-booking-repository.js'
import { bookingDbOf, createPrismaClient } from '../../src/infrastructure/prisma-client.js'
import {
  OUTBOX_LOCK_KEY,
  createOutboxRelay,
  type OutboxMessage,
  type OutboxTransport,
} from '../../src/infrastructure/outbox-relay.js'
import { draftChange, sampleKey } from '../../src/testing/builders.js'
import { integrationEnv } from './env.js'

/**
 * Penerbit outbox terhadap PostgreSQL SUNGGUHAN: kunci penasihat transaksi
 * yang menjamin satu penerbit pada satu waktu — sifat yang TIDAK ditiru
 * palsuan, karena transaksi palsuan berjalan satu per satu.
 *
 * Pengiriman ke broker diganti pencatat di sini; pengiriman ke Kafka dan
 * RabbitMQ sungguhan diuji di saga-flow.test.ts.
 */

const { databaseUrl } = integrationEnv()
const prisma = createPrismaClient(databaseUrl)
const db = bookingDbOf(prisma)
const sql = new pg.Pool({ connectionString: databaseUrl })
const logger = createLogger({ serviceName: 'booking-it', level: 'silent' })

afterAll(async () => {
  await prisma.$disconnect()
  await sql.end()
})

function recorder(): OutboxTransport & { readonly sent: OutboxMessage[] } {
  const sent: OutboxMessage[] = []
  return {
    sent,
    send: async (message) => {
      await Promise.resolve()
      sent.push(message)
    },
  }
}

function relay(transport: OutboxTransport) {
  return createOutboxRelay(db, transport, {
    batch: 1_000,
    transactionTimeoutMs: 30_000,
    now: () => new Date(),
    logger,
  })
}

let sequence = 0
async function newBooking(): Promise<string> {
  sequence += 1
  const suffix = `${String(Date.now()).slice(-6)}${String(sequence).padStart(6, '0')}`
  const change = draftChange({
    id: `44444444-5555-4666-8777-${suffix}`,
    userId: `cccccccc-dddd-4eee-8fff-${suffix}`,
    key: sampleKey(suffix),
  })
  await createPrismaBookingRepository(db).create(change)
  return change.booking.id
}

describe('satu penerbit pada satu waktu', () => {
  test('selama instance lain memegang kunci, penerbit ini tidak menerbitkan apa pun', async () => {
    await newBooking()
    const other = await sql.connect()
    try {
      await other.query('BEGIN')
      await other.query('SELECT pg_advisory_xact_lock($1)', [OUTBOX_LOCK_KEY.toString()])

      const transport = recorder()
      expect(await relay(transport).relayOnce()).toMatchObject({ locked: false, published: 0 })
      expect(transport.sent).toEqual([])
    } finally {
      await other.query('ROLLBACK')
      other.release()
    }

    expect((await relay(recorder()).relayOnce()).locked).toBe(true)
  })

  test('dua penerbit serentak: setiap pesan terbit tepat sekali, dalam urutan', async () => {
    const bookings = await Promise.all(Array.from({ length: 5 }, async () => await newBooking()))
    const first = recorder()
    const second = recorder()

    await Promise.all([relay(first).relayOnce(), relay(second).relayOnce()])

    const sent = [...first.sent, ...second.sent].filter((message) =>
      bookings.includes(message.bookingId),
    )
    expect(sent).toHaveLength(bookings.length)
    expect(new Set(sent.map((message) => message.id)).size).toBe(bookings.length)
  })
})

describe('pesan yang ditolak kontraknya', () => {
  test('disisihkan, dan pesan di belakangnya tetap terbit', async () => {
    const poisoned = await newBooking()
    const healthy = await newBooking()
    await sql.query(`UPDATE outbox SET payload = '{"rusak": true}'::jsonb WHERE booking_id = $1`, [
      poisoned,
    ])
    const transport: OutboxTransport & { readonly sent: OutboxMessage[] } = {
      sent: [],
      send: async (message) => {
        await Promise.resolve()
        if (message.bookingId === poisoned) {
          throw new ValidationError('payload tidak sesuai kontrak')
        }
        transport.sent.push(message)
      },
    }

    await relay(transport).relayOnce()

    const row = await prisma.outboxMessage.findFirst({ where: { bookingId: poisoned } })
    expect(row?.rejectedAt).not.toBeNull()
    expect(row?.publishedAt).toBeNull()
    expect(transport.sent.map((message) => message.bookingId)).toContain(healthy)
  })
})
