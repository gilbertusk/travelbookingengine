import { afterAll, afterEach, beforeAll, expect, test } from 'vitest'
import type { InfraControl } from '../harness/infra-control.js'
import { assertInvariants } from '../harness/invariants.js'
import type { System } from '../harness/system.js'
import {
  allFinal,
  captureTrace,
  countByStatus,
  heldLoad,
  paymentIntents,
  record,
  settleAll,
  startChaosSystem,
  stopwatch,
} from './support.js'

/**
 * Chaos 3 — booking-service DIBUNUH di tengah saga (Step 28).
 *
 * Berbeda dari crash-recovery.test.ts Step 20, yang membunuh satu pemesanan
 * pada satu langkah yang dipilih: di sini empat pemesanan dibayar serentak dan
 * proses dibunuh SEGERA setelah notifikasi terakhir diterima payment-service.
 * Pada saat itu setiap pemesanan berada di titik yang berbeda — peristiwa
 * pembayaran belum dikonsumsi, perintah konfirmasi tertulis di outbox tetapi
 * belum terbit, atau jawaban supplier menunggu di Kafka — dan pemulihan harus
 * menuntaskan semuanya tanpa tahu yang mana.
 *
 * Trace pemulihan satu pemesanan diunduh dari Jaeger untuk laporan chaos.
 */

const LOAD = 4
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

test('3. booking-service dimatikan di tengah saga', async () => {
  const journeys = await heldLoad(system, LOAD)
  const ids = journeys.map((journey) => journey.bookingId)
  const payments = await paymentIntents(system, journeys)

  await settleAll(system, payments)
  await system.killBooking()
  // Lima detik mati: cukup bagi supplier-service untuk menjawab perintah yang
  // sudah terbit, sehingga jawabannya menunggu di Kafka tanpa pembaca.
  await new Promise((resolve) => setTimeout(resolve, 5_000))
  await system.restartBooking()
  const elapsed = stopwatch()

  const statuses = await allFinal(system, journeys, 180_000)
  const recoveryMs = elapsed()
  await assertInvariants(system, ids)

  expect([...statuses.values()].every((status) => status === 'CONFIRMED')).toBe(true)
  const first = ids[0]
  const trace = first === undefined ? undefined : await captureTrace(system, first, 'kill-booking')
  await record({
    id: 'booking-killed-mid-saga',
    title: 'booking-service dimatikan di tengah saga',
    fault: 'SIGKILL segera setelah notifikasi pembayaran terakhir diterima; mati 5 detik',
    bookings: LOAD,
    statuses: countByStatus(statuses),
    recoveryMs,
    notes: ['dihitung sejak proses baru dinyalakan, termasuk waktu startup-nya'],
    trace,
  })
})
