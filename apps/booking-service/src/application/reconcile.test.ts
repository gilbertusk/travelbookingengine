import { createLogger } from '@tbe/shared-kernel'
import { describe, expect, test } from 'vitest'
import type { Booking } from '../domain/booking.js'
import type { LedgerAnswer, SupplierRecord } from '../domain/reconciliation.js'
import {
  createPrismaReconciliationSource,
  createPrismaReconciliationStore,
} from '../infrastructure/prisma-reconciliation.js'
import { applyCommand } from '../domain/transitions.js'
import { idr, T0, validCommand } from '../testing/builders.js'
import { harness, type Harness } from '../testing/fakes.js'
import {
  memoryReconciliationDb,
  type MemoryReconciliationDb,
} from '../testing/memory-reconciliation.js'
import { storedBooking, TO_CONFIRMED, TO_PAID_CANCELLED, TO_REFUNDED } from '../testing/stored.js'
import {
  reconcile,
  type ReconcileDeps,
  type ReconcilePolicy,
  type ReconciliationSource,
  type RunRequest,
  type SupplierLedger,
} from './reconcile.js'

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS
const POLICY: ReconcilePolicy = {
  lookbackMs: 30 * DAY_MS,
  graceMs: 10 * MINUTE_MS,
  maxBookings: 100,
}
const RUN: RunRequest = { id: '0b5e7a5e-1c2d-4e3f-8a9b-0c1d2e3f4a5b', day: '2026-10-01' }

/** Catatan supplier yang cocok dengan pemesanan contoh: harga hold dan tanggal menginap. */
const ACTIVE: SupplierRecord = {
  status: 'CONFIRMED',
  total: idr(1_800_000),
  checkIn: '2026-11-10',
  checkOut: '2026-11-12',
}

interface ScriptedLedger extends SupplierLedger {
  /** Jawaban per pegangan: booking reference atau idempotency key. */
  readonly answers: Map<string, LedgerAnswer>
  readonly asked: string[]
}

function scriptedLedger(fallback: LedgerAnswer = { kind: 'not_found' }): ScriptedLedger {
  const answers = new Map<string, LedgerAnswer>()
  const asked: string[] = []
  return {
    answers,
    asked,
    lookup: async (query) => {
      const handle =
        'bookingReference' in query ? query.bookingReference : `key:${query.idempotencyKey}`
      asked.push(handle)
      return await Promise.resolve(answers.get(handle) ?? fallback)
    },
  }
}

interface World {
  readonly world: Harness
  readonly ledger: ScriptedLedger
  readonly reports: MemoryReconciliationDb
  readonly deps: ReconcileDeps
}

function setup(ledger: ScriptedLedger = scriptedLedger({ kind: 'found', record: ACTIVE })): World {
  const world = harness({ clock: { value: T0 } })
  const reports = memoryReconciliationDb()
  return {
    world,
    ledger,
    reports,
    deps: {
      source: createPrismaReconciliationSource(world.db),
      ledger,
      runs: createPrismaReconciliationStore(reports),
      bookings: world.deps.bookings,
      clock: world.deps.clock,
      logger: createLogger({ serviceName: 'reconcile-test', level: 'silent' }),
      policy: POLICY,
    },
  }
}

/** Dijalankan sejam setelah langkah terakhir: di luar masa tenggang. */
async function runLater(setupWorld: World, request: RunRequest = RUN) {
  setupWorld.world.advance(60 * MINUTE_MS)
  return await reconcile(setupWorld.deps, request)
}

async function current(world: Harness, booking: Booking) {
  const found = await world.deps.bookings.findById(booking.id)
  if (found === undefined) throw new Error(`pemesanan ${booking.id} hilang`)
  return found
}

describe('CONFIRMED yang cocok dengan supplier', () => {
  test('tidak disentuh, dan putarannya tercatat selesai dengan hitungannya', async () => {
    const w = setup()
    const booking = await storedBooking(w.world, '1', ...TO_CONFIRMED)

    const outcome = await runLater(w)

    expect(outcome).toEqual({
      kind: 'finished',
      totals: { checked: 1, matched: 1, mismatched: 0, unverified: 0, flagged: 0 },
    })
    expect((await current(w.world, booking)).status).toBe('CONFIRMED')
    expect(w.ledger.asked).toEqual(['SKY-BK-778812'])
    expect(w.reports.runs.get(RUN.id)).toMatchObject({ checked: 1, matched: 1 })
    expect(w.reports.runs.get(RUN.id)?.finishedAt).toBeInstanceOf(Date)
    expect(w.reports.findings).toEqual([])
  })
})

describe('ketidaksesuaian dipindahkan ke NEEDS_REVIEW', () => {
  test('CONFIRMED yang tidak ada di supplier', async () => {
    const w = setup(scriptedLedger({ kind: 'not_found' }))
    const booking = await storedBooking(w.world, '1', ...TO_CONFIRMED)

    const outcome = await runLater(w)

    const after = await current(w.world, booking)
    expect(after.status).toBe('NEEDS_REVIEW')
    expect(after.review).toEqual({
      from: 'CONFIRMED',
      reason: 'rekonsiliasi: CONFIRMED di sini, tidak ditemukan di supplier SKY (SKY-BK-778812)',
    })
    expect(outcome).toMatchObject({ totals: { mismatched: 1, flagged: 1 } })
    expect(w.reports.findings).toEqual([
      expect.objectContaining({
        runId: RUN.id,
        bookingId: booking.id,
        localStatus: 'CONFIRMED',
        kind: 'missing_at_supplier',
        flagged: true,
      }),
    ])
  })

  test('REFUNDED yang masih aktif di supplier — ditanyakan lewat idempotency key, satu-satunya pegangannya', async () => {
    const ledger = scriptedLedger({ kind: 'not_found' })
    const w = setup(ledger)
    const booking = await storedBooking(w.world, '1', ...TO_REFUNDED)
    ledger.answers.set(`key:${booking.id}`, { kind: 'found', record: ACTIVE })

    await runLater(w)

    expect(ledger.asked).toEqual([`key:${booking.id}`])
    const after = await current(w.world, booking)
    expect(after.status).toBe('NEEDS_REVIEW')
    expect(after.review?.from).toBe('REFUNDED')
    expect(w.reports.findings[0]?.kind).toBe('active_at_supplier')
  })

  test('CANCELLED oleh pengguna yang masih aktif di supplier', async () => {
    const w = setup()
    const booking = await storedBooking(w.world, '1', ...TO_PAID_CANCELLED)

    await runLater(w)

    const after = await current(w.world, booking)
    expect(after.status).toBe('NEEDS_REVIEW')
    expect(after.review?.from).toBe('CANCELLED')
  })

  test('nilai dibandingkan dengan harga bersih saat hold, bukan dengan harga jual', async () => {
    // Harga jual pemesanan contoh 2.220.000 (markup dan pajak); harga hold 1.800.000.
    const w = setup(scriptedLedger({ kind: 'found', record: { ...ACTIVE, total: idr(1_800_001) } }))
    const booking = await storedBooking(w.world, '1', ...TO_CONFIRMED)

    await runLater(w)

    expect(w.reports.findings[0]?.kind).toBe('amount_mismatch')
    expect((await current(w.world, booking)).status).toBe('NEEDS_REVIEW')
  })

  test('tanggal yang berbeda', async () => {
    const w = setup(
      scriptedLedger({ kind: 'found', record: { ...ACTIVE, checkOut: '2026-11-13' } }),
    )
    await storedBooking(w.world, '1', ...TO_CONFIRMED)

    await runLater(w)

    expect(w.reports.findings[0]?.kind).toBe('dates_mismatch')
  })

  test('tidak ada perbaikan otomatis: satu-satunya pesan keluar adalah permintaan peninjauan', async () => {
    const w = setup(scriptedLedger({ kind: 'not_found' }))
    await storedBooking(w.world, '1', ...TO_CONFIRMED)
    const before = w.world.db.committed().outbox.length

    await runLater(w)

    const sent = w.world.db.committed().outbox.slice(before)
    // Tidak ada payment.refund, supplier.confirm, supplier.cancel, atau
    // booking.confirmed: hanya kabar bahwa pemesanan perlu ditinjau.
    expect(sent.map((row) => row.messageType)).toEqual(['booking.failed'])
    expect(sent[0]?.payload).toMatchObject({ stage: 'reconciliation', requiresManualReview: true })
  })
})

describe('yang tidak diketahui bukan ketidaksesuaian', () => {
  test('supplier yang tidak dapat ditanya: dicatat unverified, pemesanan tidak disentuh', async () => {
    const w = setup(scriptedLedger({ kind: 'unreachable' }))
    const booking = await storedBooking(w.world, '1', ...TO_CONFIRMED)

    const outcome = await runLater(w)

    expect((await current(w.world, booking)).status).toBe('CONFIRMED')
    expect(outcome).toMatchObject({ totals: { unverified: 1, mismatched: 0, flagged: 0 } })
    expect(w.reports.findings).toEqual([
      expect.objectContaining({ kind: 'unverified', flagged: false }),
    ])
  })
})

describe('pemesanan yang diperiksa', () => {
  test('yang baru berubah dalam masa tenggang dilewati — catatan supplier mungkin belum terlihat', async () => {
    const w = setup(scriptedLedger({ kind: 'not_found' }))
    const booking = await storedBooking(w.world, '1', ...TO_CONFIRMED)
    w.world.advance(5 * MINUTE_MS)

    await reconcile(w.deps, RUN)

    expect(w.ledger.asked).toEqual([])
    expect((await current(w.world, booking)).status).toBe('CONFIRMED')
  })

  test('menginap yang sudah selesai tidak diperiksa lagi', async () => {
    const w = setup(scriptedLedger({ kind: 'not_found' }))
    await storedBooking(w.world, '1', ...TO_CONFIRMED)
    // Tanggal keluar 12 November; putaran pada 13 November.
    w.world.advance(Date.parse('2026-11-13T00:00:00Z') - T0.getTime())

    await reconcile(w.deps, RUN)

    expect(w.ledger.asked).toEqual([])
  })

  test('REFUNDED di luar jangka mundur tidak diperiksa', async () => {
    const w = setup()
    await storedBooking(w.world, '1', ...TO_REFUNDED)
    w.world.advance(31 * DAY_MS)

    await reconcile(w.deps, RUN)

    expect(w.ledger.asked).toEqual([])
  })

  test('CANCELLED yang tidak pernah dibayar tidak pernah ditanyakan', async () => {
    const w = setup()
    await storedBooking(w.world, '1', 'cancel')
    await storedBooking(w.world, '2', 'verifyPrice', 'hold', 'cancel')

    await runLater(w)

    expect(w.ledger.asked).toEqual([])
  })

  test('keadaan tengah dan NEEDS_REVIEW tidak diperiksa', async () => {
    const w = setup()
    await storedBooking(w.world, '1', 'verifyPrice', 'hold', 'recordPayment')
    await storedBooking(w.world, '2', 'verifyPrice', 'hold', 'recordPayment', 'requireReview')
    await storedBooking(w.world, '3', 'verifyPrice', 'hold', 'recordPayment', 'fail')

    await runLater(w)

    expect(w.ledger.asked).toEqual([])
  })

  test('batas per putaran: yang paling lama tidak berubah diperiksa lebih dulu', async () => {
    const w = setup(scriptedLedger({ kind: 'not_found' }))
    // Empat langkah: berubah terakhir T0+4m. Enam langkah: T0+6m.
    const older = await storedBooking(w.world, '1', ...TO_CONFIRMED)
    const newer = await storedBooking(
      w.world,
      '2',
      ...TO_CONFIRMED,
      'requestCancellation',
      'restoreConfirmation',
    )

    w.world.advance(60 * MINUTE_MS)
    const outcome = await reconcile({ ...w.deps, policy: { ...POLICY, maxBookings: 1 } }, RUN)

    expect(outcome).toMatchObject({ totals: { checked: 1, flagged: 1 } })
    expect((await current(w.world, older)).status).toBe('NEEDS_REVIEW')
    expect((await current(w.world, newer)).status).toBe('CONFIRMED')
  })

  test('perintah untuk satu supplier melewati pemesanan supplier lain', async () => {
    const w = setup(scriptedLedger({ kind: 'not_found' }))
    const booking = await storedBooking(w.world, '1', ...TO_CONFIRMED)

    const outcome = await runLater(w, { ...RUN, supplier: 'NOVA' })

    expect(outcome).toMatchObject({ totals: { checked: 0 } })
    expect((await current(w.world, booking)).status).toBe('CONFIRMED')
  })

  test('CANCELLED tanpa pembayaran yang lolos dari kueri dilewati, tidak menghentikan putaran', async () => {
    const w = setup(scriptedLedger({ kind: 'not_found' }))
    const unpaid = await storedBooking(w.world, '1', 'cancel')
    const confirmed = await storedBooking(w.world, '2', ...TO_CONFIRMED)
    const leaky: ReconciliationSource = {
      ...w.deps.source,
      candidates: async () => await Promise.resolve([unpaid, confirmed]),
    }

    const outcome = await runLater({ ...w, deps: { ...w.deps, source: leaky } })

    expect(outcome).toMatchObject({ totals: { checked: 1, flagged: 1 } })
  })
})

describe('putaran sebagai satuan kerja', () => {
  test('putaran yang sudah selesai tidak dijalankan lagi — instance lain, atau pesan yang dikirim ulang', async () => {
    const w = setup(scriptedLedger({ kind: 'not_found' }))
    await storedBooking(w.world, '1', ...TO_CONFIRMED)
    await runLater(w)
    const asked = w.ledger.asked.length

    const again = await reconcile(w.deps, RUN)

    expect(again).toEqual({ kind: 'already_finished' })
    expect(w.ledger.asked).toHaveLength(asked)
  })

  test('putaran yang mati di tengah dilanjutkan oleh pesan yang sama', async () => {
    const w = setup(scriptedLedger({ kind: 'not_found' }))
    const booking = await storedBooking(w.world, '1', ...TO_CONFIRMED)
    w.world.advance(60 * MINUTE_MS)
    // Putaran pertama dimulai, lalu prosesnya mati sebelum `finish`.
    await w.deps.runs.begin(RUN, w.world.now())

    const outcome = await reconcile(w.deps, RUN)

    expect(outcome).toMatchObject({ kind: 'finished', totals: { flagged: 1 } })
    expect((await current(w.world, booking)).status).toBe('NEEDS_REVIEW')
  })

  test('pemesanan yang bergerak sebelum ditandai: temuannya dicatat, tidak ditandai', async () => {
    const w = setup(scriptedLedger({ kind: 'not_found' }))
    const booking = await storedBooking(w.world, '1', ...TO_CONFIRMED)
    // Pengguna meminta pembatalan tepat saat supplier ditanya.
    const ledger: SupplierLedger = {
      lookup: async (query) => {
        await storedMove(w.world, booking)
        return await w.ledger.lookup(query)
      },
    }

    const outcome = await runLater({ ...w, deps: { ...w.deps, ledger } })

    expect(outcome).toMatchObject({ totals: { mismatched: 1, flagged: 0 } })
    expect(w.reports.findings[0]?.flagged).toBe(false)
    expect((await current(w.world, booking)).status).toBe('CANCELLING')
  })
})

async function storedMove(world: Harness, booking: Booking): Promise<void> {
  const moved = applyCommand(booking, validCommand(booking, 'requestCancellation'))
  if (!moved.ok) throw moved.error
  await world.deps.bookings.save(moved.value)
}
