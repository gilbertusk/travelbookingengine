import { createLogger, ValidationError } from '@tbe/shared-kernel'
import { describe, expect, test } from 'vitest'
import type { BookingEventType } from '../domain/events.js'
import type { MemoryBookingDb } from '../testing/memory-db.js'
import { sagaWorld } from '../testing/saga-world.js'
import { createOutboxRelay, type OutboxMessage, type OutboxTransport } from './outbox-relay.js'

/**
 * Penerbit outbox: minimal sekali, berurutan, dan tidak pernah tertahan
 * selamanya oleh satu pesan yang tidak akan pernah lolos.
 */

const logger = createLogger({ serviceName: 'booking-service-test', level: 'silent' })

interface Broker extends OutboxTransport {
  readonly delivered: OutboxMessage[]
  /** Pesan ke-n berikutnya gagal dengan galat ini. */
  failOn(type: string, error: Error): void
}

function broker(): Broker {
  const delivered: OutboxMessage[] = []
  const failures = new Map<string, Error>()

  return {
    delivered,
    failOn: (type, error) => {
      failures.set(type, error)
    },
    async send(message) {
      await Promise.resolve()
      const failure = failures.get(message.messageType)
      if (failure !== undefined) {
        failures.delete(message.messageType)
        throw failure
      }
      delivered.push(message)
    },
  }
}

function relayOver(db: MemoryBookingDb, transport: OutboxTransport, batch = 100) {
  return createOutboxRelay(db, transport, {
    batch,
    transactionTimeoutMs: 1_000,
    now: () => new Date('2026-10-01T03:05:00.000Z'),
    logger,
  })
}

/** Saga lengkap sampai REFUNDED: tujuh pesan outbox untuk satu pemesanan. */
async function refundedSaga() {
  const world = sagaWorld()
  const paid = await world.paid()
  await world.supplierRejected(paid)
  await world.paymentRefunded(paid)
  return { world, db: world.db, bookingId: paid.id }
}

describe('penerbitan', () => {
  test('menerbitkan seluruh pesan dalam urutan tulisnya, lalu menandainya terbit', async () => {
    const { db, world, bookingId } = await refundedSaga()
    const transport = broker()

    const report = await relayOver(db, transport).relayOnce()

    expect(report).toEqual({ locked: true, published: 5, rejected: 0, stalled: false })
    expect(transport.delivered.map((message) => message.messageType)).toEqual(world.sent(bookingId))
    expect(db.committed().outbox.every((row) => row.publishedAt !== null)).toBe(true)
  })

  test('amplop yang ditetapkan saat ditulis ikut terbit: eventId = id baris', async () => {
    const { db } = await refundedSaga()
    const transport = broker()

    await relayOver(db, transport).relayOnce()

    expect(transport.delivered.map((message) => message.id)).toEqual(
      db.committed().outbox.map((row) => row.id),
    )
  })

  test('putaran berikutnya tidak menerbitkan ulang yang sudah terbit', async () => {
    const { db } = await refundedSaga()
    const transport = broker()
    const relay = relayOver(db, transport)

    await relay.relayOnce()
    const second = await relay.relayOnce()

    expect(second.published).toBe(0)
  })

  test('batch membatasi satu putaran', async () => {
    const { db } = await refundedSaga()

    expect((await relayOver(db, broker(), 2).relayOnce()).published).toBe(2)
  })
})

describe('kegagalan', () => {
  test('kegagalan sementara menghentikan putaran di pesan itu — urutan per pemesanan tidak dibalik', async () => {
    const { db } = await refundedSaga()
    const transport = broker()
    transport.failOn('supplier.confirm', new Error('broker tidak dapat dihubungi'))

    const report = await relayOver(db, transport).relayOnce()

    expect(report).toMatchObject({ published: 2, stalled: true })
    const stuck = db.committed().outbox.find((row) => row.messageType === 'supplier.confirm')
    expect(stuck).toMatchObject({
      publishedAt: null,
      attempts: 1,
      lastError: 'broker tidak dapat dihubungi',
    })

    const retried = await relayOver(db, transport).relayOnce()
    expect(retried.published).toBe(3)
  })

  test('pesan yang ditolak kontraknya disisihkan dan tidak menahan pesan di belakangnya', async () => {
    const { db } = await refundedSaga()
    const transport = broker()
    transport.failOn('booking.held', new ValidationError('kontrak berubah'))

    const report = await relayOver(db, transport).relayOnce()

    expect(report).toMatchObject({ published: 4, rejected: 1, stalled: false })
    const rejected = db.committed().outbox.find((row) => row.messageType === 'booking.held')
    expect(rejected?.rejectedAt).not.toBeNull()
  })

  test('galat yang bukan Error pun tercatat, tidak hilang', async () => {
    const { db } = await refundedSaga()
    const transport: OutboxTransport = {
      send: async () => {
        // Meniru pustaka pihak ketiga, yang tidak terikat aturan lint kita
        // dan tidak menjanjikan Error; nilai lain pun harus tercatat.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        await Promise.reject('ECONNREFUSED')
      },
    }

    await relayOver(db, transport).relayOnce()

    expect(db.committed().outbox[0]?.lastError).toBe('ECONNREFUSED')
  })

  test('kunci penasihat dipegang instance lain: tidak ada yang diterbitkan', async () => {
    const { db } = await refundedSaga()
    db.holdOutboxLockElsewhere(true)

    expect(await relayOver(db, broker()).relayOnce()).toEqual({
      locked: false,
      published: 0,
      rejected: 0,
      stalled: false,
    })
  })
})

describe('perubahan keadaan dan penerbitan peristiwa selalu konsisten', () => {
  /**
   * Uji wajib "Outbox: perubahan keadaan dan penerbitan peristiwa selalu
   * konsisten", sebagai sifat: untuk SETIAP peristiwa domain yang tercatat di
   * booking_events dan punya padanan kontrak, tepat satu pesan dengan jenis
   * itu terbit — tidak lebih, tidak kurang — walau penerbitnya gagal di
   * tengah dan diulang.
   */
  test('setiap peristiwa domain yang tersimpan terbit, dan tidak ada yang terbit tanpa tersimpan', async () => {
    const { db } = await refundedSaga()
    const transport = broker()
    transport.failOn('booking.failed', new Error('putus'))

    const relay = relayOver(db, transport)
    await relay.relayOnce()
    await relay.relayOnce()

    const expected = db
      .committed()
      .events.filter((event) => hasContract(event.eventType))
      .map((event) => ({ bookingId: event.bookingId, sequence: event.sequence }))
    const published = transport.delivered.filter((message) => message.channel === 'kafka')

    expect(published).toHaveLength(expected.length)
    expect(new Set(published.map((message) => message.id)).size).toBe(published.length)
  })
})

/**
 * Peristiwa domain yang punya padanan kontrak — sama dengan cabang
 * `toContractEvent` yang tidak mengembalikan undefined (contract-payloads.ts,
 * dan ujinya di contract-payloads.test.ts).
 */
const WITH_CONTRACT: ReadonlySet<BookingEventType> = new Set([
  'BookingCreated',
  'PriceChanged',
  'BookingHeld',
  'HoldExpired',
  'BookingConfirmed',
  'BookingFailed',
  'BookingCancelled',
  'ReviewRequired',
])

function hasContract(type: BookingEventType): boolean {
  return WITH_CONTRACT.has(type)
}
