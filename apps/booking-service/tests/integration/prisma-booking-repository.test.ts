import { afterAll, describe, expect, test } from 'vitest'
import type { BookingDb, BookingTx } from '../../src/infrastructure/booking-db.js'
import { toStateColumns } from '../../src/infrastructure/booking-rows.js'
import { createPrismaBookingRepository } from '../../src/infrastructure/prisma-booking-repository.js'
import { bookingDbOf, createPrismaClient } from '../../src/infrastructure/prisma-client.js'
import { BOOKING_STATUSES, type Booking } from '../../src/domain/booking.js'
import type { BookingCommand } from '../../src/domain/commands.js'
import type { BookingChange } from '../../src/domain/events.js'
import { applyCommand } from '../../src/domain/transitions.js'
import { money } from '@tbe/money'
import {
  draftChange,
  inState,
  minutesAfter,
  narrow,
  refunding,
  sampleKey,
  sampleQuote,
  step,
  validCommand,
} from '../../src/testing/builders.js'
import { integrationEnv } from './env.js'

/**
 * Repository terhadap Postgres 16 SUNGGUHAN, lewat klien Prisma tergenerate
 * dan @prisma/adapter-pg — bukan palsuan.
 *
 * Seluruh yang di Step 16 tertulis "terbukti terhadap palsuan; BELUM terhadap
 * Postgres sungguhan" diuji ulang di sini.
 */

const { databaseUrl } = integrationEnv()
const prisma = createPrismaClient(databaseUrl)
const db = bookingDbOf(prisma)
const repository = createPrismaBookingRepository(db)

afterAll(async () => {
  await prisma.$disconnect()
})

/** Batas hold yang tidak akan pernah dicapai jam uji mana pun. */
const PARKED_HOLD_UNTIL = new Date('2099-01-01T00:00:00.000Z')

let sequence = 0
/** Pengenal unik per uji: tabel tidak dapat dikosongkan — trigger append-only menolaknya. */
function fresh() {
  sequence += 1
  const suffix = `${String(Date.now()).slice(-6)}${String(sequence).padStart(6, '0')}`
  return {
    id: `11111111-2222-4333-8444-${suffix}`,
    userId: `aaaaaaaa-bbbb-4ccc-8ddd-${suffix}`,
    key: sampleKey(suffix),
  }
}

/**
 * HELD diparkir jauh di masa depan. Basis data dipakai bersama seluruh berkas
 * uji integrasi, dan penyapu di hold-flow.test.ts menyapu SEMUA hold yang
 * lewat — termasuk pemesanan contoh yang ditulis langsung ke kolom tanpa
 * saga. Dengan `heldUntil` bawaan builder (T0 + 15 menit, 2026-10-01) uji
 * pulang-pergi adalah bom waktu: lulus sampai tanggal itu lewat, lalu
 * hold-flow gagal setiap kali berkas ini berjalan lebih dulu (Step 20).
 */
function parked(booking: Booking): Booking {
  return booking.status === 'HELD' ? { ...booking, heldUntil: PARKED_HOLD_UNTIL } : booking
}

function change(booking: Booking, command: BookingCommand): BookingChange {
  const result = applyCommand(booking, command)
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/** Klien Prisma sungguhan yang tulisan peristiwanya dipaksa gagal di DALAM transaksi. */
function failingEvents(real: BookingDb): BookingDb {
  return {
    ...real,
    booking: real.booking,
    sagaState: real.sagaState,
    $transaction: async (fn) =>
      await real.$transaction(async (tx) => {
        const sabotaged: BookingTx = {
          ...tx,
          booking: tx.booking,
          bookingEvent: {
            create: async () => {
              await Promise.resolve()
              throw new Error('kegagalan disuntikkan setelah baris pemesanan ditulis')
            },
          },
        }
        return await fn(sabotaged)
      }),
  }
}

async function eventsOf(bookingId: string) {
  return await prisma.bookingEvent.findMany({ where: { bookingId }, orderBy: { sequence: 'asc' } })
}

describe('satu transaksi: bookings dan booking_events', () => {
  test('peristiwa yang gagal ditulis membatalkan baris pemesanan di Postgres', async () => {
    const { id, userId, key } = fresh()

    await expect(
      createPrismaBookingRepository(failingEvents(db)).create(draftChange({ id, userId, key })),
    ).rejects.toThrow('kegagalan disuntikkan')

    expect(await prisma.booking.findUnique({ where: { id } })).toBeNull()
  })

  test('peristiwa yang gagal ditulis membatalkan transisi di Postgres', async () => {
    const { id, userId, key } = fresh()
    const created = draftChange({ id, userId, key })
    await repository.create(created)

    await expect(
      createPrismaBookingRepository(failingEvents(db)).save(
        change(created.booking, validCommand(created.booking, 'verifyPrice')),
      ),
    ).rejects.toThrow()

    expect((await repository.findById(id))?.status).toBe('DRAFT')
    expect(await eventsOf(id)).toHaveLength(1)
  })
})

describe('idempotensi (FR-18) terhadap batasan UNIK sungguhan', () => {
  test('sepuluh pembuatan serentak dengan kunci yang sama: satu pemesanan, sembilan duplikat', async () => {
    const { userId, key } = fresh()
    const attempts = Array.from({ length: 10 }, () => draftChange({ id: fresh().id, userId, key }))

    const outcomes = await Promise.all(
      attempts.map(async (attempt) => await repository.create(attempt)),
    )

    // Ini juga membuktikan Prisma 7 + adapter-pg melaporkan pelanggaran UNIK
    // sebagai P2002 — asumsi Step 16 yang belum pernah diamati langsung.
    expect(outcomes.filter((outcome) => outcome.kind === 'created')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.kind === 'duplicate')).toHaveLength(9)
    expect(await prisma.booking.count({ where: { userId } })).toBe(1)
  })

  test('tabrakan id yang bukan kunci idempotensi tetap dilempar', async () => {
    const { id, userId, key } = fresh()
    await repository.create(draftChange({ id, userId, key }))

    await expect(
      repository.create(draftChange({ id, userId, key: sampleKey('lain') })),
    ).rejects.toMatchObject({
      code: 'P2002',
    })
  })
})

describe('kunci versi terhadap kunci baris Postgres', () => {
  test('dua transisi serentak dari versi yang sama: satu tersimpan, satu basi', async () => {
    const { id, userId, key } = fresh()
    const created = draftChange({ id, userId, key })
    await repository.create(created)
    const checked = change(created.booking, validCommand(created.booking, 'verifyPrice'))
    await repository.save(checked)
    const held = change(checked.booking, validCommand(checked.booking, 'hold'))
    await repository.save(held)

    const [expire, pay] = await Promise.all([
      repository.save(change(held.booking, validCommand(held.booking, 'expireHold'))),
      repository.save(change(held.booking, validCommand(held.booking, 'recordPayment'))),
    ])

    expect([expire.kind, pay.kind].sort()).toEqual(['saved', 'stale'])
    expect((await eventsOf(id)).map((event) => event.sequence)).toEqual([1, 2, 3, 4])
  })
})

describe('kolom DATE (NFR-09) lewat adapter-pg', () => {
  test(`tanggal menginap tersimpan dan terbaca apa adanya di zona ${String(process.env.TZ)}`, async () => {
    const { id, userId, key } = fresh()
    await repository.create(draftChange({ id, userId, key }))

    const [row] = await prisma.$queryRaw<{ check_in: string; check_out: string }[]>`
      SELECT check_in::text AS check_in, check_out::text AS check_out FROM bookings WHERE id = ${id}::uuid`

    expect(row).toEqual({ check_in: '2026-11-10', check_out: '2026-11-12' })
    expect((await repository.findById(id))?.stay).toEqual({
      checkIn: '2026-11-10',
      checkOut: '2026-11-12',
    })
  })
})

describe('setiap keadaan pulang-pergi melewati Postgres', () => {
  test.each(BOOKING_STATUSES)('%s', async (status) => {
    const { id, userId, key } = fresh()
    const target = parked({ ...inState(status), id, userId, idempotencyKey: key })
    const { booking: draft, event } = draftChange({ id, userId, key })
    await repository.create({ booking: draft, event })

    // Keadaan tujuan ditulis lewat pemetaan kolom sungguhan: yang diuji di sini
    // CHECK di migrasi dan pembacaan kembali, bukan urutan transisi.
    await db.$transaction(async (tx) => {
      await tx.booking.updateMany({ where: { id, version: 1 }, data: toStateColumns(target) })
    })

    expect(await repository.findById(id)).toEqual(target)
  })
})

describe('pembatalan oleh pengguna pulang-pergi melewati Postgres (Step 25)', () => {
  function cancelledWithoutRefund(): Booking {
    const confirmed = inState('CONFIRMED')
    const at = minutesAfter(confirmed.updatedAt, 1)
    const cancelling = step(confirmed, {
      type: 'requestCancellation',
      at,
      quote: sampleQuote(money(0, 'IDR')),
      replyBy: minutesAfter(at, 10),
    })

    return step(cancelling, {
      type: 'completeCancellation',
      at: minutesAfter(at, 1),
      settlement: { kind: 'nothing_due' },
    })
  }

  test.each([
    ['CANCELLING menunggu refund', () => refunding()],
    [
      'CANCELLED dengan refund',
      () => step(refunding(), validCommand(refunding(), 'completeCancellation')),
    ],
    ['CANCELLED tanpa dana kembali', cancelledWithoutRefund],
    [
      'NEEDS_REVIEW dari CANCELLING',
      () => step(refunding(), validCommand(refunding(), 'requireReview')),
    ],
  ])('%s', async (_name, build) => {
    const { id, userId, key } = fresh()
    const target = { ...build(), id, userId, idempotencyKey: key }
    await repository.create(draftChange({ id, userId, key }))

    await db.$transaction(async (tx) => {
      await tx.booking.updateMany({ where: { id, version: 1 }, data: toStateColumns(target) })
    })

    expect(await repository.findById(id)).toEqual(target)
  })
})

describe('booking_events hanya bertambah (NFR-10)', () => {
  /**
   * Setiap uji membuat pemesanannya sendiri dan menyasar BARIS miliknya.
   * Trigger UPDATE/DELETE berlaku per baris: pada tabel kosong, keduanya tidak
   * menolak apa pun karena tidak ada baris yang tersentuh. Versi pertama
   * bergantung pada baris yang dibuat uji lain, dan pengacakan urutan uji
   * yang menemukannya.
   */
  test.each([
    [
      'UPDATE',
      (id: string) => `UPDATE booking_events SET payload = '{}'::jsonb WHERE booking_id = '${id}'`,
    ],
    ['DELETE', (id: string) => `DELETE FROM booking_events WHERE booking_id = '${id}'`],
    ['TRUNCATE', () => 'TRUNCATE booking_events'],
  ])('%s ditolak trigger', async (_name, sql) => {
    const { id, userId, key } = fresh()
    await repository.create(draftChange({ id, userId, key }))

    await expect(prisma.$executeRawUnsafe(sql(id))).rejects.toThrow(
      'booking_events hanya bertambah',
    )
    expect(await eventsOf(id)).toHaveLength(1)
  })

  test('pemesanan yang punya jejak tidak dapat dihapus', async () => {
    const { id, userId, key } = fresh()
    await repository.create(draftChange({ id, userId, key }))

    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM bookings WHERE id = '${id}'`),
    ).rejects.toThrow()
  })
})

describe('batasan CHECK per keadaan', () => {
  test.each([
    [
      'CONFIRMED tanpa supplier_ref',
      "status = 'CONFIRMED', payment_id = gen_random_uuid()",
      'confirmed_has_supplier_ref',
    ],
    ['DRAFT dengan hold_ref', "hold_ref = 'x'", 'draft_is_bare'],
    ['HELD tanpa held_until', "status = 'HELD', hold_ref = 'x'", 'hold_complete'],
    ['PAID tanpa payment_id', "status = 'PAID'", 'paid_has_payment'],
    ['check_out tidak setelah check_in', 'check_out = check_in', 'stay_order'],
    ['nilai nol', 'amount_minor = 0', 'amount_positive'],
    [
      'CANCELLING tanpa langkah yang ditunggu',
      "status = 'CANCELLING', payment_id = gen_random_uuid(), supplier_ref = 'x'",
      'cancelling_complete',
    ],
    [
      'CANCELLING tanpa booking reference',
      "status = 'CANCELLING', payment_id = gen_random_uuid(), cancel_refund_minor = 0, " +
        'cancel_refund_currency = currency, cancel_refund_percent = 0, cancel_requested_at = now(), ' +
        "cancel_step = 'supplier', cancel_deadline_at = now()",
      'confirmed_has_supplier_ref',
    ],
    ['langkah pembatalan di luar CANCELLING', "cancel_step = 'supplier'", 'cancel_step_only'],
    [
      'pengembalian melebihi pembayaran',
      'cancel_refund_minor = amount_minor + 1, cancel_refund_currency = currency',
      'cancel_refund_bounds',
    ],
    ['persentase di luar 0–100', 'cancel_refund_percent = 150', 'cancel_refund_percent'],
  ])('%s ditolak', async (_name, assignments, constraint) => {
    const { id, userId, key } = fresh()
    await repository.create(draftChange({ id, userId, key }))

    await expect(
      prisma.$executeRawUnsafe(`UPDATE bookings SET ${assignments} WHERE id = '${id}'`),
    ).rejects.toThrow(constraint)
  })
})

describe('penyapu: kueri hold yang lewat', () => {
  test('hanya HELD yang lewat, termasuk tepat pada batasnya, yang paling lama lebih dulu', async () => {
    const make = async (offsetMs: number) => {
      const { id, userId, key } = fresh()
      const created = draftChange({ id, userId, key })
      await repository.create(created)
      const checked = change(created.booking, validCommand(created.booking, 'verifyPrice'))
      await repository.save(checked)
      const held = change(checked.booking, {
        type: 'hold',
        at: checked.booking.updatedAt,
        holdRef: 'h',
        heldUntil: new Date(Date.UTC(2031, 0, 1) + offsetMs),
      })
      await repository.save(held)
      return id
    }
    const later = await make(2_000)
    const exact = await make(0)
    const future = await make(10_000)

    // Batas besar: basis data dipakai bersama seluruh berkas uji integrasi, dan
    // hold-flow.test.ts meninggalkan pemesanan HELD yang lebih tua. Versi
    // pertama memakai batas 10 dan gagal hanya bila berkas itu berjalan lebih
    // dulu — urutan berkas, bukan kebetulan.
    const due = await repository.findExpiredHolds(new Date(Date.UTC(2031, 0, 1) + 2_000), 1_000)
    const ids = due.map((booking) => booking.id)

    expect(ids.indexOf(exact)).toBeLessThan(ids.indexOf(later))
    expect(ids).toContain(later)
    expect(ids).not.toContain(future)
  })
})

describe('penyapu: kueri pembatalan yang lewat (Step 25)', () => {
  test('hanya CANCELLING yang batasnya lewat, yang paling lama lebih dulu', async () => {
    const make = async (deadline: Date) => {
      const { id, userId, key } = fresh()
      const target = {
        ...narrow(inState('CANCELLING'), 'CANCELLING'),
        id,
        userId,
        idempotencyKey: key,
        cancellationStage: { step: 'supplier' as const, deadlineAt: deadline },
      }
      await repository.create(draftChange({ id, userId, key }))
      await db.$transaction(async (tx) => {
        await tx.booking.updateMany({ where: { id, version: 1 }, data: toStateColumns(target) })
      })
      return id
    }
    const base = Date.UTC(2032, 0, 1)
    const later = await make(new Date(base + 2_000))
    const exact = await make(new Date(base))
    const future = await make(new Date(base + 10_000))

    const due = await repository.findOverdueCancellations(new Date(base + 2_000), 1_000)
    const ids = due.map((booking) => booking.id)

    expect(ids.indexOf(exact)).toBeLessThan(ids.indexOf(later))
    expect(ids).toContain(later)
    expect(ids).not.toContain(future)
  })
})
