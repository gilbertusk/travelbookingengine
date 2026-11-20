import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, test } from 'vitest'
import type { Booking } from '../../src/domain/booking.js'
import type { CommandType } from '../../src/domain/commands.js'
import { applyCommand } from '../../src/domain/transitions.js'
import { createPrismaBookingRepository } from '../../src/infrastructure/prisma-booking-repository.js'
import {
  bookingDbOf,
  createPrismaClient,
  reconciliationDbOf,
} from '../../src/infrastructure/prisma-client.js'
import {
  createPrismaReconciliationReports,
  createPrismaReconciliationSource,
  createPrismaReconciliationStore,
} from '../../src/infrastructure/prisma-reconciliation.js'
import { draftChange, idr, sampleKey, T0, validCommand } from '../../src/testing/builders.js'
import { TO_CONFIRMED, TO_PAID_CANCELLED, TO_REFUNDED } from '../../src/testing/stored.js'
import { integrationEnv } from './env.js'

/**
 * Rekonsiliasi terhadap Postgres 16 SUNGGUHAN (Step 28): kueri kandidat
 * dengan `OR`, `payment_id IS NOT NULL`, dan batas `updated_at`; pembacaan
 * harga hold dari jejak peristiwa; serta penyatuan putaran lewat
 * `ON CONFLICT DO NOTHING` — tiga hal yang palsuan memori hanya meniru.
 *
 * Basis datanya dipakai bersama berkas integrasi lain dan tidak dapat
 * dikosongkan, jadi setiap pernyataan tentang kandidat dibatasi ke pemesanan
 * yang dibuat berkas ini.
 */

const { databaseUrl } = integrationEnv()
const prisma = createPrismaClient(databaseUrl)
const db = bookingDbOf(prisma)
const reports = reconciliationDbOf(prisma)
const repository = createPrismaBookingRepository(db)
const source = createPrismaReconciliationSource(db)
const store = createPrismaReconciliationStore(reports)

afterAll(async () => {
  await prisma.$disconnect()
})

let sequence = 0
async function stored(...path: CommandType[]): Promise<Booking> {
  sequence += 1
  const suffix = `${String(Date.now()).slice(-6)}${String(sequence).padStart(6, '0')}`
  const created = draftChange({
    id: `22222222-3333-4444-8555-${suffix}`,
    userId: `bbbbbbbb-cccc-4ddd-8eee-${suffix}`,
    key: sampleKey(suffix),
  })
  await repository.create(created)

  let booking: Booking = created.booking
  for (const type of path) {
    // HELD diparkir jauh di depan: penyapu hold di hold-flow.test.ts menyapu
    // SETIAP hold yang lewat di basis data bersama ini.
    const command = validCommand(booking, type)
    const applied = applyCommand(
      booking,
      command.type === 'hold'
        ? { ...command, heldUntil: new Date('2099-01-01T00:00:00Z') }
        : command,
    )
    if (!applied.ok) throw applied.error
    await repository.save(applied.value)
    booking = applied.value.booking
  }
  return booking
}

const HOUR_MS = 60 * 60 * 1_000

describe('kandidat rekonsiliasi', () => {
  test('CONFIRMED yang belum selesai menginap, REFUNDED, dan CANCELLED yang dibayar — bukan yang lain', async () => {
    const confirmed = await stored(...TO_CONFIRMED)
    const refunded = await stored(...TO_REFUNDED)
    const paidCancelled = await stored(...TO_PAID_CANCELLED)
    const unpaidCancelled = await stored('cancel')
    const paid = await stored('verifyPrice', 'hold', 'recordPayment')
    const mine = new Set(
      [confirmed, refunded, paidCancelled, unpaidCancelled, paid].map((b) => b.id),
    )

    const found = await source.candidates(
      {
        today: new Date('2026-11-01T00:00:00Z'),
        since: new Date(T0.getTime() - HOUR_MS),
        until: new Date(T0.getTime() + HOUR_MS),
      },
      5_000,
    )

    expect(
      found
        .filter((b) => mine.has(b.id))
        .map((b) => b.id)
        .sort(),
    ).toEqual([confirmed.id, refunded.id, paidCancelled.id].sort())
  })

  test('menginap yang selesai, perubahan dalam masa tenggang, dan REFUNDED di luar jangka mundur tidak dipilih', async () => {
    const confirmed = await stored(...TO_CONFIRMED)
    const refunded = await stored(...TO_REFUNDED)
    const mine = new Set([confirmed.id, refunded.id])
    const pick = async (window: { today: Date; since: Date; until: Date }) =>
      (await source.candidates(window, 5_000)).filter((b) => mine.has(b.id)).map((b) => b.id)

    // Tanggal keluar 12 November.
    expect(
      await pick({
        today: new Date('2026-11-13T00:00:00Z'),
        since: new Date(T0.getTime() - HOUR_MS),
        until: new Date(T0.getTime() + HOUR_MS),
      }),
    ).toEqual([refunded.id])
    // Keduanya berubah sesudah `until`.
    expect(
      await pick({ today: new Date('2026-11-01T00:00:00Z'), since: new Date(0), until: T0 }),
    ).toEqual([])
    // REFUNDED berubah sebelum `since`.
    expect(
      await pick({
        today: new Date('2026-11-01T00:00:00Z'),
        since: new Date(T0.getTime() + HOUR_MS),
        until: new Date(T0.getTime() + 2 * HOUR_MS),
      }),
    ).toEqual([confirmed.id])
  })

  test('harga bersih supplier dibaca dari peristiwa BookingHeld di jejak', async () => {
    const confirmed = await stored(...TO_CONFIRMED)
    const draft = await stored()

    expect(await source.supplierTotalOf(confirmed.id)).toEqual(idr(1_800_000))
    expect(await source.supplierTotalOf(draft.id)).toBeUndefined()
  })
})

describe('putaran dan laporannya', () => {
  test('mulai, dilanjutkan, selesai — lalu ditolak sebagai sudah selesai', async () => {
    const run = { id: randomUUID(), day: '2026-10-01' }

    expect(await store.begin(run, T0)).toBe('started')
    expect(await store.begin(run, T0)).toBe('resumed')
    await store.finish(
      run.id,
      { checked: 1, matched: 0, mismatched: 1, unverified: 0, flagged: 1 },
      T0,
    )
    expect(await store.begin(run, T0)).toBe('finished')
  })

  test('dua instance memulai putaran yang sama serentak: tepat satu yang memulai', async () => {
    const run = { id: randomUUID(), day: '2026-10-01' }

    const starts = await Promise.all([
      store.begin(run, T0),
      store.begin(run, T0),
      store.begin(run, T0),
    ])

    expect(starts.filter((start) => start === 'started')).toHaveLength(1)
  })

  test('temuan yang sama dalam putaran yang dilanjutkan ditimpa, bukan digandakan', async () => {
    const run = { id: randomUUID(), day: '2026-10-01' }
    const booking = await stored(...TO_CONFIRMED)
    await store.begin(run, new Date('2099-01-01T00:00:00Z'))
    const finding = {
      runId: run.id,
      bookingId: booking.id,
      supplier: 'SKY',
      localStatus: 'CONFIRMED',
      kind: 'missing_at_supplier',
      detail: 'rekonsiliasi: uji',
      flagged: false,
      recordedAt: T0,
    } as const

    await store.record(finding)
    await store.record({ ...finding, flagged: true })

    const [latest] = await createPrismaReconciliationReports(reports).recent(1, 10)
    expect(latest?.id).toBe(run.id)
    expect(latest?.findings).toEqual([
      expect.objectContaining({ bookingId: booking.id, flagged: true }),
    ])
  })

  test('jenis temuan yang tidak dikenal ditolak basis data', async () => {
    const run = { id: randomUUID(), day: '2026-10-01' }
    await store.begin(run, T0)

    // Lewat port basis data langsung, bukan lewat penyimpan: jenisnya di sana
    // bertipe string, seperti baris yang ditulis tangan dari luar domain.
    const row = {
      runId: run.id,
      bookingId: randomUUID(),
      supplier: 'SKY',
      localStatus: 'CONFIRMED',
      kind: 'looks_fine',
      detail: 'x',
      flagged: false,
      recordedAt: T0,
    } as const
    await expect(
      reports.reconciliationFinding.upsert({
        where: { runId_bookingId: { runId: row.runId, bookingId: row.bookingId } },
        create: row,
        update: row,
      }),
    ).rejects.toThrow(/reconciliation_findings_kind_known/)
  })
})
