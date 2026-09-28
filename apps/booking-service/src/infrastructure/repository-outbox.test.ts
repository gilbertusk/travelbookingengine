import { describe, expect, test } from 'vitest'
import { applyCommand } from '../domain/transitions.js'
import { draftChange, samplePrice, validCommand } from '../testing/builders.js'
import { autocommitBookingDb, memoryBookingDb } from '../testing/memory-db.js'
import { createPrismaBookingRepository } from './prisma-booking-repository.js'

/**
 * Step 19: setiap penyimpanan pemesanan menulis padanan Kafka peristiwanya ke
 * outbox, dalam transaksi yang SAMA.
 *
 * Dua pelanggaran yang ditangkap di sini, masing-masing dengan suntikan di
 * step doc: peristiwa yang diterbitkan langsung di transaksi bisnis (terbit
 * walau transaksinya batal), dan baris outbox yang ditulis di transaksi
 * terpisah (keadaan berubah tanpa peristiwanya bila tulisan kedua gagal).
 */

describe('pemesanan dan outbox dalam SATU transaksi', () => {
  test('pembuatan menulis booking.created ke outbox — yang dinanti payment-service', async () => {
    const db = memoryBookingDb()
    const repository = createPrismaBookingRepository(db)

    await repository.create(draftChange())

    expect(db.committed().outbox).toMatchObject([
      {
        channel: 'kafka',
        messageType: 'booking.created',
        payload: { amount: { amountMinor: 2_220_000, currency: 'IDR' } },
      },
    ])
  })

  test('outbox yang gagal ditulis membatalkan pembuatan pemesanan', async () => {
    const db = memoryBookingDb()
    db.failNext('outboxMessage.create')

    await expect(createPrismaBookingRepository(db).create(draftChange())).rejects.toThrow()

    expect(db.committed().bookings.size).toBe(0)
    expect(db.committed().events).toHaveLength(0)
  })

  test('outbox yang gagal ditulis membatalkan transisi', async () => {
    const db = memoryBookingDb()
    const repository = createPrismaBookingRepository(db)
    const draft = draftChange()
    await repository.create(draft)
    // Harga berubah: PriceChanged punya padanan booking.price_changed.
    const changed = applyCommand(draft.booking, {
      type: 'verifyPrice',
      at: draft.booking.updatedAt,
      verified: samplePrice(1_100_000),
    })
    if (!changed.ok) throw new Error('persiapan gagal')
    db.failNext('outboxMessage.create')

    await expect(repository.save(changed.value)).rejects.toThrow()

    expect((await repository.findById(draft.booking.id))?.status).toBe('DRAFT')
  })

  test('uji tidak hampa: tanpa rollback, pemesanan tertinggal tanpa booking.created-nya', async () => {
    const db = autocommitBookingDb()
    db.failNext('outboxMessage.create')

    await expect(createPrismaBookingRepository(db).create(draftChange())).rejects.toThrow()

    expect(db.committed().bookings.size).toBe(1)
    expect(db.committed().outbox).toHaveLength(0)
  })

  test('peristiwa tanpa padanan kontrak tidak menulis apa pun ke outbox', async () => {
    // PriceVerified adalah catatan audit internal (contract-payloads.ts).
    const db = memoryBookingDb()
    const repository = createPrismaBookingRepository(db)
    const draft = draftChange()
    await repository.create(draft)
    const verified = applyCommand(draft.booking, validCommand(draft.booking, 'verifyPrice'))
    if (!verified.ok) throw new Error('persiapan gagal')

    await repository.save(verified.value)

    expect(db.committed().outbox.map((row) => row.messageType)).toEqual(['booking.created'])
  })
})
