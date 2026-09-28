import { describe, expect, test } from 'vitest'
import type { SagaUnit } from '../application/ports.js'
import { beginSaga, enterStep } from '../domain/saga-state.js'
import type { Booking } from '../domain/booking.js'
import type { BookingChange } from '../domain/events.js'
import { applyCommand } from '../domain/transitions.js'
import { draftChange, inState, validCommand } from '../testing/builders.js'
import {
  autocommitBookingDb,
  memoryBookingDb,
  type Failpoint,
  type MemoryBookingDb,
} from '../testing/memory-db.js'
import { createPrismaBookingRepository } from './prisma-booking-repository.js'
import { commitUnit } from './unit-of-work.js'

/**
 * Satu unit kerja saga = satu transaksi. Diuji terhadap palsuan yang meniru
 * rollback, DAN terhadap palsuan tandingan tanpa rollback — uji yang sama
 * WAJIB gagal pada tandingannya, kalau tidak ujinya hampa. Terhadap Postgres
 * sungguhan: tests/integration/saga-store.test.ts.
 */

const T1 = new Date('2026-10-01T03:01:00.000Z')

function change(command: Parameters<typeof applyCommand>[1]): BookingChange {
  const held = inState('HELD')
  const result = applyCommand(held, command)
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/** Pemesanan HELD beserta sagannya, tersimpan — titik awal setiap uji. */
async function seeded(db: MemoryBookingDb) {
  const repository = createPrismaBookingRepository(db)
  await repository.create(draftChange())
  let booking: Booking = draftChange().booking
  for (const type of ['verifyPrice', 'hold'] as const) {
    const next = applyCommand(booking, validCommand(booking, type))
    if (!next.ok) throw new Error(next.error.message)
    await repository.save(next.value)
    booking = next.value.booking
  }
  const saga = beginSaga(booking.id, T1, 60_000)
  await commitUnit(db, { bookingId: booking.id, at: T1, saga })
  return { booking, saga }
}

async function paymentUnit(db: MemoryBookingDb): Promise<SagaUnit> {
  const { booking, saga } = await seeded(db)
  const paid = change(validCommand(inState('HELD'), 'recordPayment'))
  return {
    bookingId: booking.id,
    at: T1,
    change: paid,
    saga: enterStep(saga, 'holdSupplier', T1, 60_000),
    commands: [{ type: 'voucher.generate', payload: { bookingId: booking.id } }],
    consumed: { eventId: '0199f000-0000-7000-8000-00000000abcd', eventType: 'payment.succeeded' },
  }
}

const FAILPOINTS: readonly Failpoint[] = [
  'consumedMessage.create',
  'booking.updateMany',
  'bookingEvent.create',
  'outboxMessage.create',
  'sagaState.updateMany',
]

describe('semua atau tidak sama sekali', () => {
  test.each(FAILPOINTS)(
    'kegagalan pada %s membatalkan pemesanan, jejak, saga, outbox, DAN catatan pesan',
    async (point) => {
      const db = memoryBookingDb()
      const unit = await paymentUnit(db)
      const before = structuredClone(db.committed())
      db.failNext(point)

      await expect(commitUnit(db, unit)).rejects.toThrow(`kegagalan disuntikkan pada ${point}`)

      expect(db.committed()).toEqual(before)
    },
  )

  test('uji tidak hampa: tanpa rollback, kegagalan di tengah meninggalkan keadaan tanpa outbox-nya', async () => {
    const db = autocommitBookingDb()
    const unit = await paymentUnit(db)
    db.failNext('outboxMessage.create')

    await expect(commitUnit(db, unit)).rejects.toThrow()

    const booking = db.committed().bookings.get(unit.bookingId)
    expect(booking?.status).toBe('PAID')
    expect(db.committed().outbox.map((row) => row.messageType)).not.toContain('voucher.generate')
  })

  test('berhasil: satu transaksi menulis semuanya', async () => {
    const db = memoryBookingDb()
    const unit = await paymentUnit(db)
    const transactions = db.transactions()

    expect(await commitUnit(db, unit)).toBe('committed')

    expect(db.transactions()).toBe(transactions + 1)
    expect(db.committed().consumed.size).toBe(1)
    expect(
      db
        .committed()
        .outbox.map((row) => row.messageType)
        .slice(-1),
    ).toEqual(['voucher.generate'])
  })
})

describe('kunci versi dan pesan terkonsumsi', () => {
  test('pesan yang sudah dikonsumsi: tidak ada yang ditulis', async () => {
    const db = memoryBookingDb()
    const unit = await paymentUnit(db)
    await commitUnit(db, unit)
    const before = structuredClone(db.committed())
    const again: SagaUnit = {
      bookingId: unit.bookingId,
      at: T1,
      ...(unit.consumed === undefined ? {} : { consumed: unit.consumed }),
    }

    expect(await commitUnit(db, again)).toBe('already_consumed')
    expect(db.committed()).toEqual(before)
  })

  test('saga "baru" untuk pemesanan yang sudah punya saga: stale, dan transisinya ikut batal', async () => {
    const db = memoryBookingDb()
    const unit = await paymentUnit(db)
    const before = structuredClone(db.committed())
    const stale: SagaUnit = {
      bookingId: unit.bookingId,
      at: T1,
      ...(unit.change === undefined ? {} : { change: unit.change }),
      saga: beginSaga(unit.bookingId, T1, 1),
    }

    expect(await commitUnit(db, stale)).toBe('stale')
    expect(db.committed()).toEqual(before)
  })

  test('versi pemesanan yang sudah berubah: stale', async () => {
    const db = memoryBookingDb()
    const unit = await paymentUnit(db)
    await commitUnit(db, unit)
    const again: SagaUnit = {
      bookingId: unit.bookingId,
      at: T1,
      ...(unit.change === undefined ? {} : { change: unit.change }),
    }

    expect(await commitUnit(db, again)).toBe('stale')
  })

  test('galat lain dilempar apa adanya, bukan disamarkan menjadi stale', async () => {
    const db = memoryBookingDb()
    await paymentUnit(db)
    const unknown = '00000000-0000-4000-8000-00000000dead'

    await expect(
      commitUnit(db, {
        bookingId: unknown,
        at: T1,
        commands: [{ type: 'voucher.generate', payload: { bookingId: unknown } }],
      }),
    ).rejects.toThrow(/fkey/)
  })

  test('saga baru untuk pemesanan yang tidak ada: galat kunci asing dilempar, bukan stale', async () => {
    const db = memoryBookingDb()
    const unknown = '00000000-0000-4000-8000-00000000dead'

    await expect(
      commitUnit(db, { bookingId: unknown, at: T1, saga: beginSaga(unknown, T1, 1) }),
    ).rejects.toThrow(/fkey/)
  })
})
