import { randomUUID } from 'node:crypto'
import { request } from 'undici'
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest'
import { z } from 'zod'
import { bookingRow, outboxCount } from '../harness/db.js'
import type { InfraControl } from '../harness/infra-control.js'
import { assertInvariants } from '../harness/invariants.js'
import { held, pay, waitForStatus } from '../harness/journey.js'
import type { System } from '../harness/system.js'
import { waitFor } from '../harness/waits.js'
import { allFinal, countByStatus, record, startChaosSystem, stopwatch } from './support.js'

/**
 * Rekonsiliasi terhadap sistem sungguhan (Step 28, FR-33).
 *
 * Bukan salah satu dari sembilan skenario prompt, tetapi jaring pengaman yang
 * diminta step yang sama: kegagalan yang TIDAK terlihat oleh saga — supplier
 * membatalkan pemesanan terkonfirmasi tanpa memberi tahu, dan pemesanan
 * bayangan muncul untuk pemesanan yang sudah direfund — ditemukan putaran
 * rekonsiliasi yang diminta operator lewat panel, dan dipindahkan ke
 * NEEDS_REVIEW tanpa satu pun refund atau pembatalan otomatis.
 */

const OPERATOR = { 'x-tbe-user-id': randomUUID(), 'x-tbe-user-role': 'operator' }

let system: System
let infra: InfraControl

beforeAll(async () => {
  ;({ system, infra } = await startChaosSystem())
})

afterAll(async () => {
  await system.stop()
})

afterEach(async (context) => {
  if (context.task.result?.state === 'fail') await system.dumpLogs(context.task.name)
  await infra.restoreAll()
  await system.reset()
})

const runsSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      finishedAt: z.string().nullable(),
      flagged: z.number(),
      findings: z.array(
        z.object({ bookingId: z.string(), kind: z.string(), flagged: z.boolean() }),
      ),
    }),
  ),
})

type Run = z.infer<typeof runsSchema>['data'][number]

async function runs(): Promise<Run[]> {
  const response = await request(`${system.booking.url}/ops/bookings/reconciliation`, {
    headers: OPERATOR,
  })
  return runsSchema.parse(await response.body.json()).data
}

/**
 * Meminta satu putaran lewat rute panel operator dan menunggu selesai.
 * Mengembalikan putaran itu beserta SELURUH putaran yang tercatat: penjadwal
 * booking-service mengirim putaran slotnya sendiri pada detak pertamanya
 * (semenit setelah menyala), dan putaran itu boleh saja menemukan
 * ketidaksesuaian yang sama lebih dulu.
 */
async function runReconciliation(): Promise<{ run: Run; all: Run[] }> {
  const started = await request(`${system.booking.url}/ops/bookings/reconciliation/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...OPERATOR },
    body: '{}',
  })
  const body = z.object({ data: z.object({ runId: z.string() }) }).parse(await started.body.json())
  expect(started.statusCode).toBe(202)

  const all = await waitFor(
    `putaran rekonsiliasi ${body.data.runId} selesai`,
    runs,
    (list) => list.some((run) => run.id === body.data.runId && run.finishedAt !== null),
    120_000,
  )
  const run = all.find((candidate) => candidate.id === body.data.runId)
  if (run === undefined) throw new Error('putaran tidak ditemukan')
  return { run, all }
}

test('rekonsiliasi menemukan yang tidak terlihat saga, dan hanya menandainya', async () => {
  // A: terkonfirmasi, lalu dibatalkan supplier tanpa memberi tahu siapa pun.
  const cancelledBehind = await held(system)
  await pay(system, cancelledBehind)
  const confirmedA = await waitForStatus(system, cancelledBehind, 'CONFIRMED', 90_000)
  const cancel = await request(`${system.supplierService.url}/internal/suppliers/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ supplier: 'SKY', bookingReference: confirmedA.supplierRef }),
  })
  await cancel.body.dump()
  expect(cancel.statusCode).toBe(200)

  // B: terkonfirmasi dan cocok — tidak boleh disentuh.
  const intact = await held(system)
  await pay(system, intact)
  await waitForStatus(system, intact, 'CONFIRMED', 90_000)

  // C: supplier menolak (503) sampai saga mengembalikan dana, lalu pemesanan
  // dibuat di supplier DI LUAR saga — bentuk perintah konfirmasi dari dead
  // letter yang diputar ulang setelah refund.
  const shadow = await held(system)
  await system.supplier.panelRefuse()
  await pay(system, shadow)
  await waitForStatus(system, shadow, 'REFUNDED', 300_000)
  await system.supplier.reset()
  await system.supplier.bookBehindSaga({
    bookingId: shadow.bookingId,
    ratePlan: shadow.ratePlan,
    stay: shadow.stay,
  })

  const refundsBefore = system.midtrans.refunds.length
  // Masa tenggang rekonsiliasi di sistem chaos satu detik.
  await new Promise((resolve) => setTimeout(resolve, 2_000))
  const elapsed = stopwatch()
  const { run, all } = await runReconciliation()
  const runMs = elapsed()

  const journeys = [cancelledBehind, intact, shadow]
  const statuses = await allFinal(system, journeys, 30_000)
  expect(statuses.get(cancelledBehind.bookingId)).toBe('NEEDS_REVIEW')
  expect(statuses.get(intact.bookingId)).toBe('CONFIRMED')
  expect(statuses.get(shadow.bookingId)).toBe('NEEDS_REVIEW')
  const flagged = all.flatMap((each) => each.findings.filter((finding) => finding.flagged))
  expect(flagged.map((finding) => [finding.bookingId, finding.kind]).sort()).toEqual(
    [
      [cancelledBehind.bookingId, 'cancelled_at_supplier'],
      [shadow.bookingId, 'active_at_supplier'],
    ].sort(),
  )

  // Tidak ada perbaikan otomatis: tidak ada refund baru, tidak ada perintah
  // refund atau pembatalan supplier, dan pemesanan bayangan masih aktif.
  expect(system.midtrans.refunds).toHaveLength(refundsBefore)
  expect(await outboxCount(system.db.booking, cancelledBehind.bookingId, 'payment.refund')).toBe(0)
  expect(await outboxCount(system.db.booking, shadow.bookingId, 'supplier.cancel')).toBe(0)
  const { bookings } = await system.supplier.reservations()
  expect(bookings.find((booking) => booking.idempotencyKey === shadow.bookingId)?.status).toBe(
    'CONFIRMED',
  )
  expect((await bookingRow(system.db.booking, intact.bookingId))?.status).toBe('CONFIRMED')

  await assertInvariants(
    system,
    journeys.map((journey) => journey.bookingId),
  )
  await record({
    id: 'reconciliation',
    title: 'Rekonsiliasi: pembatalan diam-diam di supplier dan pemesanan bayangan',
    fault:
      'pemesanan CONFIRMED dibatalkan langsung di supplier; pemesanan REFUNDED dibuat ulang di supplier di luar saga',
    bookings: journeys.length,
    statuses: countByStatus(statuses),
    recoveryMs: runMs,
    notes: [
      `putaran operator ${run.id}: ${String(run.flagged)} ditandai; seluruh putaran: ${String(flagged.length)} ditandai`,
      'waktu pulih: dari permintaan operator sampai putaran selesai',
      'nol refund dan nol perintah supplier sesudah putaran',
    ],
  })
})
