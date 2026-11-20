import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { statusesOf } from '../harness/db.js'
import type { InfraControl } from '../harness/infra-control.js'
import { assertInvariants } from '../harness/invariants.js'
import type { System } from '../harness/system.js'
import { waitFor } from '../harness/waits.js'
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
 * Chaos 4, 5, dan 7 — broker dan basis data mati di tengah beban (Step 28).
 *
 * Pola yang sama untuk ketiganya: empat pemesanan HELD, niat pembayarannya
 * dibuat, kegagalan disuntikkan, pembayaran diselesaikan SELAMA kegagalan,
 * lalu kegagalan dicabut dan waktu sampai seluruhnya final diukur.
 *
 * Tidak ada jalan pintas untuk "menunggu kegagalan selesai": durasinya
 * sungguhan (30 detik untuk broker, 15 untuk Postgres), karena yang diuji
 * adalah batas waktu dan sambung ulang klien yang sungguhan juga.
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

async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

describe('chaos broker dan basis data', () => {
  test('4. RabbitMQ dimatikan selama 30 detik lalu dihidupkan', async () => {
    const journeys = await heldLoad(system, LOAD)
    const ids = journeys.map((journey) => journey.bookingId)
    const payments = await paymentIntents(system, journeys)

    await infra.stopRabbit()
    const down = stopwatch()
    // Pembayaran lewat Kafka tetap tercatat; perintah konfirmasi tertahan di
    // outbox booking-service karena tidak ada broker untuk menerimanya.
    await settleAll(system, payments)
    await waitFor(
      'pembayaran tercatat selagi RabbitMQ mati',
      async () => await statusesOf(system.db.booking, ids),
      (statuses) => ids.every((id) => statuses.get(id) === 'PAID'),
      30_000,
    )
    await pause(Math.max(0, 30_000 - down()))
    await infra.startRabbit()
    const elapsed = stopwatch()

    const statuses = await allFinal(system, journeys, 180_000)
    const recoveryMs = elapsed()
    await assertInvariants(system, ids)

    expect([...statuses.values()].every((status) => status === 'CONFIRMED')).toBe(true)
    const first = ids[0]
    await record({
      id: 'rabbitmq-down-30s',
      title: 'RabbitMQ dimatikan selama 30 detik lalu dihidupkan',
      fault:
        '`rabbitmqctl stop_app` setelah niat pembayaran dibuat; pembayaran diselesaikan selama mati',
      bookings: LOAD,
      statuses: countByStatus(statuses),
      recoveryMs,
      notes: ['seluruh pembayaran tercatat PAID selama RabbitMQ mati — jalurnya Kafka'],
      trace: first === undefined ? undefined : await captureTrace(system, first, 'rabbitmq'),
    })
  })

  test('5. Kafka dimatikan selama 30 detik lalu dihidupkan', async () => {
    const journeys = await heldLoad(system, LOAD)
    const ids = journeys.map((journey) => journey.bookingId)
    const payments = await paymentIntents(system, journeys)

    await infra.freeze('kafka')
    const down = stopwatch()
    // Notifikasi diterima payment-service, tetapi `payment.succeeded` tidak
    // dapat terbit: jawabannya menunggu produser Kafka. Tidak di-await di sini
    // — penyedia sungguhan juga tidak menunggu tanpa batas.
    const settling = settleAll(system, payments)
    await pause(30_000)
    await infra.thaw('kafka')
    const elapsed = stopwatch()
    const kafkaDownMs = down()
    await settling

    const statuses = await allFinal(system, journeys, 240_000)
    const recoveryMs = elapsed()
    await assertInvariants(system, ids)

    expect([...statuses.values()].every((status) => status === 'CONFIRMED')).toBe(true)
    await record({
      id: 'kafka-down-30s',
      title: 'Kafka dimatikan selama 30 detik lalu dihidupkan',
      fault: '`docker pause` kontainer Kafka, pembayaran diselesaikan selama beku',
      bookings: LOAD,
      statuses: countByStatus(statuses),
      recoveryMs,
      notes: [
        `Kafka beku ${String(kafkaDownMs)} ms`,
        'webhook menunggu produser Kafka selama beku; lihat Temuan Step 28 untuk pemadaman yang lebih lama dari jenjang retry produser',
      ],
    })
  })

  test('7. PostgreSQL menolak koneksi sementara', async () => {
    const journeys = await heldLoad(system, LOAD)
    const ids = journeys.map((journey) => journey.bookingId)
    const payments = await paymentIntents(system, journeys)

    await settleAll(system, payments)
    // Saat terburuk: pembayaran sudah diterbitkan, booking-service baru akan
    // mencatatnya. Basis datanya menolak koneksi baru dan koneksi yang ada diputus.
    await infra.refuseConnections('booking')
    await pause(15_000)
    await infra.allowConnections('booking')
    const elapsed = stopwatch()

    const statuses = await allFinal(system, journeys, 180_000)
    const recoveryMs = elapsed()
    await assertInvariants(system, ids)

    expect([...statuses.values()].every((status) => status === 'CONFIRMED')).toBe(true)
    await record({
      id: 'postgres-refuses-connections',
      title: 'PostgreSQL menolak koneksi sementara',
      fault: 'basis data booking: ALLOW_CONNECTIONS false + pg_terminate_backend, 15 detik',
      bookings: LOAD,
      statuses: countByStatus(statuses),
      recoveryMs,
      notes: [
        'booking-service tetap hidup selama penolakan; tidak ada proses yang dinyalakan ulang',
      ],
    })
  })
})
