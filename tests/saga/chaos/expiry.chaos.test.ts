import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { bookingEvents, bookingRow, refundsOf } from '../harness/db.js'
import type { InfraControl } from '../harness/infra-control.js'
import { assertInvariants } from '../harness/invariants.js'
import { pay, paymentIntent } from '../harness/journey.js'
import type { System } from '../harness/system.js'
import {
  allFinal,
  countByStatus,
  heldLoad,
  paymentIntents,
  record,
  settleAll,
  startChaosSystem,
  stopwatch,
} from './support.js'

/**
 * Chaos 6, 8, dan 9 — kegagalan yang bertemu batas waktu hold (Step 28).
 *
 * Hold di berkas ini 40 detik, bukan 15 menit: ketiga skenario menunggu hold
 * kedaluwarsa, dan menunggu lima belas menit sungguhan per skenario membuat
 * rangkaian ini tidak dijalankan siapa pun.
 *
 * Skenario webhook (8 dan 9) menyuntikkan kegagalan DI BATAS PORT
 * PaymentGateway — di stub Midtrans harness, yang mengirim notifikasi ke
 * webhook payment-service — bukan di penyedia. Sandbox Midtrans tidak dapat
 * diperintah mengirim webhook terlambat atau terbalik (keputusan Q1). Prompt
 * Step 28 meminta payload REKAMAN notifikasi sandbox beserta tanda tangannya;
 * rekaman itu tidak ada di repositori dan server key sandbox tidak tersedia di
 * lingkungan ini. Yang dipakai: notifikasi berbentuk notifikasi Midtrans
 * dengan tanda tangan sha512 yang dihitung dengan rumus Midtrans atas server
 * key uji — verifikasi tanda tangan payment-service tetap berjalan, tetapi
 * BUKAN terhadap data asli penyedia. Dicatat di laporan chaos.
 */

const HOLD_MS = 40_000
let system: System
let infra: InfraControl

beforeAll(async () => {
  ;({ system, infra } = await startChaosSystem({ holdMs: HOLD_MS }))
})

afterAll(async () => {
  await system.stop()
})

afterEach(async (context) => {
  if (context.task.result?.state === 'fail') await system.dumpLogs(context.task.name)
  await infra.restoreAll()
  await system.reset()
})

async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

describe('chaos di sekitar batas waktu hold', () => {
  test('6. Redis dimatikan selama 10 detik lalu dihidupkan', async () => {
    const journeys = await heldLoad(system, 4)
    const ids = journeys.map((journey) => journey.bookingId)
    const [paidA, paidB, ...abandoned] = journeys
    if (paidA === undefined || paidB === undefined) throw new Error('beban tidak terbentuk')
    await Promise.all([pay(system, paidA), pay(system, paidB)])

    // Saat terburuk untuk Redis: tepat ketika hold yang tidak dibayar
    // kedaluwarsa. Notifikasi keyspace dan pelepasan kursi sama-sama butuh
    // Redis, dan yang beku tidak menjawab keduanya.
    const firstAbandoned = abandoned[0]
    const row =
      firstAbandoned === undefined
        ? undefined
        : await bookingRow(system.db.booking, firstAbandoned.bookingId)
    const expiresAt = row?.heldUntil?.getTime() ?? Date.now()
    await pause(Math.max(0, expiresAt - Date.now() - 5_000))
    await infra.freeze('redis')
    await pause(10_000)
    await infra.thaw('redis')
    const elapsed = stopwatch()

    const statuses = await allFinal(system, journeys, 120_000)
    const recoveryMs = elapsed()
    // Termasuk: tidak ada kursi yatim di Redis maupun hold yatim di supplier.
    await assertInvariants(system, ids)

    expect(statuses.get(paidA.bookingId)).toBe('CONFIRMED')
    expect(statuses.get(paidB.bookingId)).toBe('CONFIRMED')
    for (const journey of abandoned) expect(statuses.get(journey.bookingId)).toBe('EXPIRED')
    await record({
      id: 'redis-down-10s',
      title: 'Redis dimatikan selama 10 detik lalu dihidupkan',
      fault: '`docker pause` Redis lima detik sebelum dua hold kedaluwarsa, 10 detik',
      bookings: journeys.length,
      statuses: countByStatus(statuses),
      recoveryMs,
      notes: ['dua dibayar sebelum Redis beku, dua ditinggalkan dan kedaluwarsa selama beku'],
    })
  })

  test('8. penyedia pembayaran mengirim webhook terlambat 5 menit', async () => {
    const journeys = await heldLoad(system, 2)
    const ids = journeys.map((journey) => journey.bookingId)
    const payments = await paymentIntents(system, journeys)

    // Pengguna membayar, tetapi notifikasinya baru tiba lima menit kemudian —
    // jauh setelah hold 40 detiknya kedaluwarsa dan kamarnya dilepas.
    await pause(5 * 60_000)
    const elapsed = stopwatch()
    await settleAll(system, payments)

    const statuses = await allFinal(system, journeys, 120_000)
    // Uang yang tiba untuk hold yang sudah habis dikembalikan otomatis.
    for (const paymentId of payments) {
      await waitForRefund(paymentId)
    }
    const recoveryMs = elapsed()
    await assertInvariants(system, ids)

    expect([...statuses.values()]).toEqual(['EXPIRED', 'EXPIRED'])
    await record({
      id: 'webhook-late-5m',
      title: 'Penyedia pembayaran mengirim webhook terlambat 5 menit',
      fault: 'notifikasi settlement ditahan 5 menit di batas port PaymentGateway (stub Midtrans)',
      bookings: journeys.length,
      statuses: countByStatus(statuses),
      recoveryMs,
      notes: [
        'hold kedaluwarsa sebelum uang tiba; setiap pembayaran direfund otomatis (SUCCEEDED)',
        'waktu pulih: dari notifikasi terlambat diterima sampai refund tuntas',
        'payload BUKAN rekaman sandbox asli: lihat catatan berkas uji',
      ],
    })
  })

  test('9. penyedia pembayaran mengirim webhook ganda dengan urutan terbalik', async () => {
    const journeys = await heldLoad(system, 2)
    const ids = journeys.map((journey) => journey.bookingId)
    const codes: number[] = []

    for (const journey of journeys) {
      const paymentId = await paymentIntent(system, journey)
      const settled = randomUUID()
      const notify = async (status: 'settlement' | 'pending', transactionId: string) => {
        codes.push(
          await system.midtrans.notify(system.payment.url, {
            orderId: paymentId,
            status,
            transactionId,
          }),
        )
      }
      // settlement, settlement yang SAMA dikirim ulang, lalu `pending` — status
      // yang lebih tua — tiba paling akhir.
      await notify('settlement', settled)
      await notify('settlement', settled)
      await notify('pending', randomUUID())
    }

    const statuses = await allFinal(system, journeys, 120_000)
    await assertInvariants(system, ids)

    expect([...statuses.values()]).toEqual(['CONFIRMED', 'CONFIRMED'])
    // Setiap notifikasi dijawab 200: yang ganda dan yang tidak berurutan
    // diabaikan, bukan ditolak — penolakan membuat penyedia terus mengirim ulang.
    expect(codes.every((code) => code === 200)).toBe(true)
    for (const id of ids) {
      const recorded = (await bookingEvents(system.db.booking, id)).filter(
        (event) => event.type === 'PaymentRecorded',
      )
      expect(recorded).toHaveLength(1)
    }
    expect(system.midtrans.refunds).toHaveLength(0)
    await record({
      id: 'webhook-duplicate-reversed',
      title: 'Penyedia pembayaran mengirim webhook ganda dengan urutan terbalik',
      fault: 'settlement, settlement yang sama, lalu pending yang lebih tua — per pembayaran',
      bookings: journeys.length,
      statuses: countByStatus(statuses),
      recoveryMs: null,
      notes: [
        `jawaban webhook: ${codes.join(', ')}`,
        'tepat satu PaymentRecorded per pemesanan; nol refund',
        'payload BUKAN rekaman sandbox asli: lihat catatan berkas uji',
      ],
    })
  })
})

async function waitForRefund(paymentId: string): Promise<void> {
  const deadline = Date.now() + 120_000
  for (;;) {
    const refunds = await refundsOf(system.db.payment, paymentId)
    if (refunds.some((refund) => refund.status === 'SUCCEEDED')) return
    if (Date.now() > deadline) throw new Error(`pembayaran ${paymentId} tidak pernah direfund`)
    await pause(500)
  }
}
