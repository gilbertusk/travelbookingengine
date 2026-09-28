import pg from 'pg'
import { afterAll, describe, expect, test } from 'vitest'
import type { SagaUnit } from '../../src/application/ports.js'
import type { Booking } from '../../src/domain/booking.js'
import { beginSaga, enterStep } from '../../src/domain/saga-state.js'
import { applyCommand } from '../../src/domain/transitions.js'
import type { BookingDb, BookingTx } from '../../src/infrastructure/booking-db.js'
import { createPrismaBookingRepository } from '../../src/infrastructure/prisma-booking-repository.js'
import { bookingDbOf, createPrismaClient } from '../../src/infrastructure/prisma-client.js'
import { commitUnit } from '../../src/infrastructure/unit-of-work.js'
import { draftChange, sampleKey, validCommand } from '../../src/testing/builders.js'
import { integrationEnv } from './env.js'

/**
 * Unit kerja saga terhadap PostgreSQL SUNGGUHAN (Step 19).
 *
 * Yang di unit test terbukti terhadap palsuan — satu transaksi untuk
 * pemesanan, jejak, saga, outbox, dan catatan pesan terkonsumsi; kunci primer
 * catatan itu; kunci versi saga — diuji ulang di sini, termasuk yang tidak
 * dapat ditiru palsuan: DUA transaksi yang benar-benar serentak, dan batasan
 * CHECK tulisan tangan di migrasi.
 */

const { databaseUrl } = integrationEnv()
const prisma = createPrismaClient(databaseUrl)
const db = bookingDbOf(prisma)
const repository = createPrismaBookingRepository(db)
const sql = new pg.Pool({ connectionString: databaseUrl })

afterAll(async () => {
  await prisma.$disconnect()
  await sql.end()
})

let sequence = 0
function fresh() {
  sequence += 1
  const suffix = `${String(Date.now()).slice(-6)}${String(sequence).padStart(6, '0')}`
  return {
    id: `22222222-3333-4444-8555-${suffix}`,
    userId: `bbbbbbbb-cccc-4ddd-8eee-${suffix}`,
    key: sampleKey(suffix),
    eventId: `33333333-4444-4555-8666-${suffix}`,
  }
}

const T1 = new Date('2026-10-01T03:01:00.000Z')

/** Pemesanan HELD beserta sagannya, tersimpan di Postgres. */
async function heldWithSaga() {
  const ids = fresh()
  const draft = draftChange({ id: ids.id, userId: ids.userId, key: ids.key })
  await repository.create(draft)
  let booking: Booking = draft.booking
  for (const type of ['verifyPrice', 'hold'] as const) {
    const next = applyCommand(booking, validCommand(booking, type))
    if (!next.ok) throw new Error(next.error.message)
    await repository.save(next.value)
    booking = next.value.booking
  }
  const saga = beginSaga(booking.id, T1, 60_000)
  expect(await commitUnit(db, { bookingId: booking.id, at: T1, saga })).toBe('committed')
  return { booking, saga, eventId: ids.eventId }
}

async function paymentUnit(): Promise<SagaUnit> {
  const { booking, saga, eventId } = await heldWithSaga()
  const paid = applyCommand(booking, validCommand(booking, 'recordPayment'))
  if (!paid.ok) throw new Error(paid.error.message)
  return {
    bookingId: booking.id,
    at: T1,
    change: paid.value,
    saga: enterStep(saga, 'holdSupplier', T1, 60_000),
    commands: [{ type: 'voucher.generate', payload: { bookingId: booking.id } }],
    consumed: { eventId, eventType: 'payment.succeeded' },
  }
}

/** Klien sungguhan yang tulisan outbox-nya dipaksa gagal di DALAM transaksi. */
function failingOutbox(real: BookingDb): BookingDb {
  return {
    ...real,
    $transaction: async (fn, options) =>
      await real.$transaction(async (tx) => {
        const sabotaged: BookingTx = {
          ...tx,
          outboxMessage: {
            ...tx.outboxMessage,
            create: async () => {
              await Promise.resolve()
              throw new Error('kegagalan disuntikkan pada outbox')
            },
          },
        }
        return await fn(sabotaged)
      }, options),
  }
}

async function counts(bookingId: string, eventId: string) {
  const [consumed, outbox, status] = await Promise.all([
    prisma.consumedMessage.count({ where: { eventId } }),
    prisma.outboxMessage.count({ where: { bookingId } }),
    prisma.booking.findUnique({ where: { id: bookingId }, select: { status: true } }),
  ])
  return { consumed, outbox, status: status?.status }
}

describe('satu transaksi Postgres', () => {
  test('outbox yang gagal ditulis membatalkan pemesanan, saga, DAN catatan pesan terkonsumsi', async () => {
    const unit = await paymentUnit()
    const eventId = unit.consumed?.eventId ?? ''
    const before = await counts(unit.bookingId, eventId)

    await expect(commitUnit(failingOutbox(db), unit)).rejects.toThrow('kegagalan disuntikkan')

    expect(await counts(unit.bookingId, eventId)).toEqual(before)
    expect(before.status).toBe('HELD')
  })

  test('berhasil: semuanya tersimpan bersama', async () => {
    const unit = await paymentUnit()

    expect(await commitUnit(db, unit)).toBe('committed')

    const after = await counts(unit.bookingId, unit.consumed?.eventId ?? '')
    expect(after).toMatchObject({ consumed: 1, status: 'PAID' })
    const sagaRow = await prisma.sagaState.findUnique({ where: { bookingId: unit.bookingId } })
    expect(sagaRow).toMatchObject({ currentStep: 'holdSupplier', stepStatus: 'started' })
  })
})

describe('serentak sungguhan', () => {
  test('pesan yang sama dikonsumsi dua proses bersamaan: tepat satu efek', async () => {
    const unit = await paymentUnit()
    const { consumed, ...withoutMessage } = unit
    if (consumed === undefined) throw new Error('persiapan gagal')
    // Proses kedua memutuskan dari keadaan yang sama tetapi TANPA transisi
    // pemesanan — hanya perintahnya — supaya satu-satunya penjaga adalah
    // kunci primer pesan terkonsumsi.
    const commandsOnly: SagaUnit = {
      bookingId: withoutMessage.bookingId,
      at: T1,
      commands: withoutMessage.commands ?? [],
      consumed,
    }

    const outcomes = await Promise.all([commitUnit(db, unit), commitUnit(db, commandsOnly)])

    expect([...outcomes].sort()).toEqual(['already_consumed', 'committed'])
    const vouchers = await prisma.outboxMessage.count({
      where: { bookingId: unit.bookingId, messageType: 'voucher.generate' },
    })
    expect(vouchers).toBe(1)
  })

  test('dua keputusan dari versi saga yang sama: satu tersimpan, satu basi', async () => {
    const { booking, saga } = await heldWithSaga()
    const next = enterStep(saga, 'holdSupplier', T1, 60_000)

    const outcomes = await Promise.all([
      commitUnit(db, { bookingId: booking.id, at: T1, saga: next }),
      commitUnit(db, { bookingId: booking.id, at: T1, saga: next }),
    ])

    expect([...outcomes].sort()).toEqual(['committed', 'stale'])
  })
})

describe('batasan CHECK tulisan tangan (Step 19)', () => {
  test('langkah langsung tanpa sewa ditolak basis data — saga seperti itu tidak pernah dipulihkan', async () => {
    const { booking } = await heldWithSaga()

    await expect(
      sql.query(`UPDATE saga_states SET leased_until = NULL WHERE booking_id = $1`, [booking.id]),
    ).rejects.toThrow(/saga_states_started_has_lease_check/)
  })

  test('menunggu supplier tanpa batas waktu ditolak basis data', async () => {
    const { booking } = await heldWithSaga()

    await expect(
      sql.query(
        `UPDATE saga_states SET current_step = 'confirmSupplier', step_status = 'waiting',
           leased_until = NULL, deadline_at = NULL WHERE booking_id = $1`,
        [booking.id],
      ),
    ).rejects.toThrow(/saga_states_confirm_has_deadline_check/)
  })

  test('pesan outbox tidak dapat terbit dan ditolak sekaligus', async () => {
    const { booking } = await heldWithSaga()

    await expect(
      sql.query(
        `UPDATE outbox SET published_at = now(), rejected_at = now() WHERE booking_id = $1`,
        [booking.id],
      ),
    ).rejects.toThrow(/outbox_published_or_rejected_check/)
  })
})

describe('urutan outbox', () => {
  test('per pemesanan, urutan terbit sama dengan urutan perubahan keadaan', async () => {
    const unit = await paymentUnit()
    await commitUnit(db, unit)

    const rows = await prisma.outboxMessage.findMany({
      where: { bookingId: unit.bookingId },
      orderBy: { sequence: 'asc' },
      select: { messageType: true },
    })

    expect(rows.map((row) => row.messageType)).toEqual([
      'booking.created',
      'booking.held',
      'voucher.generate',
    ])
  })
})
