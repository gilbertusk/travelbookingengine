import { describe, expect, test } from 'vitest'
import {
  draftChange,
  inState,
  minutesAfter,
  priceChanged,
  sampleKey,
  USER_ID,
  validCommand,
  SAMPLE_POLICY,
} from '../testing/builders.js'
import { autocommitBookingDb, memoryBookingDb } from '../testing/memory-db.js'
import { BOOKING_STATUSES, type Booking } from '../domain/booking.js'
import type { BookingCommand } from '../domain/commands.js'
import type { BookingChange } from '../domain/events.js'
import { applyCommand } from '../domain/transitions.js'
import { toStateColumns } from './booking-rows.js'
import { createPrismaBookingRepository } from './prisma-booking-repository.js'

/**
 * Repository sungguhan terhadap basis data palsuan yang punya transaksi.
 *
 * Yang diuji di sini adalah kode repository yang akan berjalan di produksi —
 * bukan tiruannya. Yang dipalsukan hanya klien basis data di bawahnya, dan
 * palsuan itu meniru rollback, batasan UNIK, dan kunci asing (lihat
 * testing/memory-db.ts). Bahwa Postgres sungguhan berperilaku sama BELUM
 * dibuktikan; itu jatah uji integrasi saat Docker hidup kembali.
 */

function change(booking: Booking, command: BookingCommand): BookingChange {
  const result = applyCommand(booking, command)
  if (!result.ok) throw new Error(result.error.message)

  return result.value
}

describe('bookings dan booking_events dalam SATU transaksi', () => {
  test('pembuatan menulis pemesanan beserta peristiwa pertamanya', async () => {
    const db = memoryBookingDb()
    const repository = createPrismaBookingRepository(db)

    const outcome = await repository.create(draftChange())

    expect(outcome).toEqual({ kind: 'created' })
    expect(db.committed().bookings.size).toBe(1)
    expect(db.committed().events).toMatchObject([
      { eventType: 'BookingCreated', sequence: 1, payload: { guestCount: 2 } },
    ])
  })

  /**
   * Inti Definisi Selesai "booking_events tersimpan dalam transaksi yang sama".
   *
   * Penulisan peristiwa digagalkan SETELAH baris pemesanan ditulis. Dengan
   * satu transaksi, baris pemesanan ikut dibatalkan. Dengan dua penulisan atau
   * dua transaksi, baris pemesanan tertinggal tanpa jejak auditnya.
   */
  test('peristiwa yang gagal ditulis membatalkan pembuatan pemesanan', async () => {
    const db = memoryBookingDb()
    const repository = createPrismaBookingRepository(db)
    db.failNext('bookingEvent.create')

    await expect(repository.create(draftChange())).rejects.toThrow('kegagalan disuntikkan')

    expect(db.committed().bookings.size).toBe(0)
    expect(db.committed().events).toEqual([])
  })

  test('peristiwa yang gagal ditulis membatalkan transisi', async () => {
    const db = memoryBookingDb()
    const repository = createPrismaBookingRepository(db)
    const { booking } = draftChange()
    await repository.create(draftChange())
    db.failNext('bookingEvent.create')

    await expect(
      repository.save(change(booking, validCommand(booking, 'verifyPrice'))),
    ).rejects.toThrow()

    const after = await repository.findById(booking.id)
    expect(after?.status).toBe('DRAFT')
    expect(after?.version).toBe(1)
    expect(db.committed().events).toHaveLength(1)
  })

  test('pemesanan yang gagal ditulis tidak meninggalkan peristiwa', async () => {
    const db = memoryBookingDb()
    const repository = createPrismaBookingRepository(db)
    db.failNext('booking.create')

    await expect(repository.create(draftChange())).rejects.toThrow()

    expect(db.committed().events).toEqual([])
  })

  /**
   * Uji di atas tidak hampa. Repository yang SAMA terhadap basis data tanpa
   * rollback meninggalkan pemesanan tanpa peristiwanya — persis kerusakan yang
   * dicegah transaksi. Kalau uji ini lulus dengan pemesanan kosong, palsuan
   * yang dipakai uji di atas tidak benar-benar meniru transaksi.
   */
  test('uji atomisitas tidak hampa: tanpa rollback, pemesanan tertinggal tanpa jejak', async () => {
    const db = autocommitBookingDb()
    const repository = createPrismaBookingRepository(db)
    db.failNext('bookingEvent.create')

    await expect(repository.create(draftChange())).rejects.toThrow()

    expect(db.committed().bookings.size).toBe(1)
    expect(db.committed().events).toEqual([])
  })

  test('setiap penulisan terjadi di dalam transaksi', async () => {
    const db = memoryBookingDb()
    const repository = createPrismaBookingRepository(db)
    const { booking } = draftChange()

    await repository.create(draftChange())
    await repository.save(change(booking, validCommand(booking, 'verifyPrice')))

    expect(db.transactions()).toBe(2)
    expect(db.committed().events.map((event) => event.sequence)).toEqual([1, 2])
  })
})

describe('jejak audit (NFR-10)', () => {
  test('seluruh alur tercatat berurutan tanpa celah', async () => {
    const db = memoryBookingDb()
    const repository = createPrismaBookingRepository(db)
    const created = draftChange()
    await repository.create(created)

    let booking: Booking = created.booking
    for (const type of ['verifyPrice', 'hold', 'recordPayment', 'confirm'] as const) {
      const next = change(booking, validCommand(booking, type))
      expect(await repository.save(next)).toEqual({ kind: 'saved' })
      booking = next.booking
    }

    const events = db.committed().events
    expect(events.map((event) => event.eventType)).toEqual([
      'BookingCreated',
      'PriceVerified',
      'BookingHeld',
      'PaymentRecorded',
      'BookingConfirmed',
    ])
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5])
    expect(await repository.findById(booking.id)).toEqual(booking)
  })

  test('payload peristiwa memakai bentuk kontrak: ISO untuk waktu, bilangan bulat untuk uang', async () => {
    const db = memoryBookingDb()
    const repository = createPrismaBookingRepository(db)
    const created = draftChange()
    await repository.create(created)
    const checked = change(created.booking, validCommand(created.booking, 'verifyPrice'))
    await repository.save(checked)
    const held = change(checked.booking, validCommand(checked.booking, 'hold'))

    await repository.save(held)

    expect(db.committed().events[0]?.payload).toMatchObject({
      stay: { checkIn: '2026-11-10', checkOut: '2026-11-12' },
      amount: { amountMinor: 2_220_000, currency: 'IDR' },
    })
    expect(db.committed().events[2]?.payload).toEqual({
      holdRef: 'sky-hold-001',
      heldUntil: held.booking.heldUntil?.toISOString(),
    })
  })
})

describe('idempotensi pembuatan (FR-18)', () => {
  test('kunci yang sama dari pengguna yang sama mengembalikan pemesanan pertama', async () => {
    const db = memoryBookingDb()
    const repository = createPrismaBookingRepository(db)
    const first = draftChange()
    await repository.create(first)

    const again = await repository.create(
      draftChange({ id: '0e7d6c5b-4a39-4281-9f0e-1d2c3b4a5968' }),
    )

    expect(again).toEqual({ kind: 'duplicate', existing: first.booking })
    expect(db.committed().bookings.size).toBe(1)
    expect(db.committed().events).toHaveLength(1)
  })

  test('dua permintaan serentak dengan kunci yang sama menghasilkan satu pemesanan', async () => {
    const db = memoryBookingDb()
    const repository = createPrismaBookingRepository(db)
    const ids = Array.from(
      { length: 10 },
      (_, index) => `0e7d6c5b-4a39-4281-9f0e-1d2c3b4a59${String(index).padStart(2, '0')}`,
    )

    const outcomes = await Promise.all(ids.map((id) => repository.create(draftChange({ id }))))

    expect(outcomes.filter((outcome) => outcome.kind === 'created')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.kind === 'duplicate')).toHaveLength(9)
    expect(db.committed().bookings.size).toBe(1)
    expect(db.committed().events).toHaveLength(1)
  })

  test('kunci yang sama dari pengguna BERBEDA menghasilkan pemesanan berbeda', async () => {
    const db = memoryBookingDb()
    const repository = createPrismaBookingRepository(db)
    await repository.create(draftChange())

    const other = await repository.create(
      draftChange({
        id: '0e7d6c5b-4a39-4281-9f0e-1d2c3b4a5968',
        userId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
        key: sampleKey(),
      }),
    )

    expect(other).toEqual({ kind: 'created' })
  })

  test('pencarian dengan kunci idempotensi terikat pada pemiliknya', async () => {
    const db = memoryBookingDb()
    const repository = createPrismaBookingRepository(db)
    await repository.create(draftChange())

    expect(await repository.findByIdempotencyKey(USER_ID, sampleKey())).toBeDefined()
    expect(
      await repository.findByIdempotencyKey('9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', sampleKey()),
    ).toBeUndefined()
  })

  test('tabrakan id pemesanan bukan duplikat permintaan dan tetap dilempar', async () => {
    const db = memoryBookingDb()
    const repository = createPrismaBookingRepository(db)
    await repository.create(draftChange())

    await expect(repository.create(draftChange({ key: sampleKey('b') }))).rejects.toMatchObject({
      code: 'P2002',
    })
  })
})

describe('kunci versi: dua penulis tidak dapat sama-sama menang', () => {
  /**
   * Step 17 punya dua jalur yang mengedaluwarsakan hold yang sama — keyspace
   * notification Redis dan penyapu berkala — dan keduanya boleh berjalan
   * bersamaan. Pada Step 19, pembayaran dapat tiba tepat saat hold kedaluwarsa.
   * Keduanya membaca versi yang sama; hanya satu yang boleh tersimpan.
   */
  test('dua transisi dari versi yang sama: satu tersimpan, satu basi', async () => {
    const db = memoryBookingDb()
    const repository = createPrismaBookingRepository(db)
    const created = draftChange()
    await repository.create(created)
    let held: Booking = created.booking
    for (const type of ['verifyPrice', 'hold'] as const) {
      const next = change(held, validCommand(held, type))
      await repository.save(next)
      held = next.booking
    }

    const [expire, pay] = await Promise.all([
      repository.save(change(held, validCommand(held, 'expireHold'))),
      repository.save(change(held, validCommand(held, 'recordPayment'))),
    ])

    expect(expire).toEqual({ kind: 'saved' })
    expect(pay.kind).toBe('stale')
    if (pay.kind !== 'stale') return
    expect(pay.current?.status).toBe('EXPIRED')
    expect(db.committed().events.filter((event) => event.sequence === 4)).toHaveLength(1)
  })

  test('transisi atas pemesanan yang tidak ada dilaporkan basi tanpa menulis apa pun', async () => {
    const db = memoryBookingDb()
    const repository = createPrismaBookingRepository(db)
    const { booking } = draftChange()

    const outcome = await repository.save(change(booking, validCommand(booking, 'verifyPrice')))

    expect(outcome).toEqual({ kind: 'stale', current: undefined })
    expect(db.committed().events).toEqual([])
  })
})

describe('baca kembali setiap keadaan', () => {
  test.each(BOOKING_STATUSES)(
    '%s tersimpan dan terbaca kembali tanpa perubahan',
    async (status) => {
      const db = memoryBookingDb()
      const repository = createPrismaBookingRepository(db)
      const booking = inState(status)
      const { booking: draft, event } = draftChange()

      // Keadaan tujuan ditulis langsung sebagai baris lewat pembuatan, karena
      // yang diuji di sini adalah pemetaan kolom, bukan urutan transisi.
      await repository.create({ booking: draft, event })
      await db.$transaction(async (tx) => {
        await tx.booking.updateMany({
          where: { id: draft.id, version: 1 },
          data: toStateColumns(booking),
        })
      })

      expect(await repository.findById(booking.id)).toEqual(booking)
    },
  )

  test('harga yang menunggu persetujuan terbaca kembali lengkap dengan rinciannya', async () => {
    const db = memoryBookingDb()
    const repository = createPrismaBookingRepository(db)
    const created = draftChange()
    await repository.create(created)
    const changed = priceChanged()
    const next = change(created.booking, {
      type: 'verifyPrice',
      at: minutesAfter(created.booking.updatedAt, 1),
      verified: changed.priceCheck.kind === 'changed' ? changed.priceCheck.quoted : changed.price,
      policy: SAMPLE_POLICY,
    })

    await repository.save(next)

    expect(await repository.findById(created.booking.id)).toEqual(next.booking)
  })

  test('pemesanan yang tidak ada terbaca sebagai undefined', async () => {
    const repository = createPrismaBookingRepository(memoryBookingDb())
    await repository.create(draftChange())

    expect(await repository.findById('00000000-0000-4000-8000-000000000000')).toBeUndefined()
  })
})
