import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { bookingEvents, bookingRow, bookingsOfUser, outboxCount, refundsOf } from '../harness/db.js'
import { assertInvariants } from '../harness/invariants.js'
import {
  acceptPrice,
  bookingStatus,
  call,
  data,
  held,
  nextStay,
  pay,
  placeHold,
  priceCheckBody,
  waitForStatus,
  type Journey,
} from '../harness/journey.js'
import { watchKafka, type KafkaWatch } from '../harness/kafka.js'
import { startSystem, type System } from '../harness/system.js'
import { waitFor } from '../harness/waits.js'

/**
 * Skenario 1, 10, dan 11 — alur tanpa kegagalan yang disuntikkan, melintasi
 * empat service yang BERJALAN di atas Postgres, Redis, Kafka, RabbitMQ, dan
 * mock-supplier sebagai kontainer.
 */

let system: System
let kafka: KafkaWatch

beforeAll(async () => {
  system = await startSystem()
  kafka = await watchKafka(system.infra.kafkaBrokers, [
    'tbe.booking.v1',
    'tbe.payment.v1',
    'tbe.supplier-booking.v1',
  ])
})

afterAll(async () => {
  await kafka.stop()
  await system.stop()
})

afterEach(async (context) => {
  if (context.task.result?.state === 'fail') await system.dumpLogs(context.task.name)
  await system.reset()
})

describe('alur bahagia', () => {
  test('price check → hold → bayar → konfirmasi supplier → CONFIRMED', async () => {
    const journey = await held(system)

    await pay(system, journey)
    const final = await waitForStatus(system, journey, 'CONFIRMED')

    expect(final.supplierRef).not.toBeNull()
    expect(final.refund).toBeNull()
    // Peristiwa yang dijanjikan kontrak benar-benar sampai di Kafka.
    await kafka.waitForEvent('booking.created', journey.bookingId)
    await kafka.waitForEvent('payment.succeeded', journey.bookingId)
    await kafka.waitForEvent('supplier.booking_confirmed', journey.bookingId)
    await kafka.waitForEvent('booking.confirmed', journey.bookingId)

    await assertInvariants(system, [journey.bookingId])
  })
})

describe('peristiwa Kafka dikirim ulang', () => {
  test('payment.succeeded yang diterbitkan ulang tidak menghasilkan efek ganda', async () => {
    const journey = await held(system)
    await pay(system, journey)
    await waitForStatus(system, journey, 'CONFIRMED')
    const before = await bookingEvents(system.db.booking, journey.bookingId)
    const succeeded = await kafka.waitForEvent('payment.succeeded', journey.bookingId)

    // Pesan yang SAMA byte demi byte, termasuk eventId — persis yang terjadi
    // ketika consumer mati setelah efeknya tersimpan tetapi sebelum offset
    // di-commit, lalu Kafka mengirimkannya lagi.
    await kafka.republish(succeeded.raw)

    // Bukti bahwa pesan kedua BENAR-BENAR dibaca dan ditolak, bukan belum
    // sempat tiba: booking-service mencatat hasil `duplicate` untuk eventId-nya.
    await waitFor(
      `booking-service menolak ulang ${succeeded.eventId} sebagai duplikat`,
      async () => await Promise.resolve(duplicateReactions(system, succeeded.eventId)),
      (count) => count >= 1,
    )
    expect(await bookingEvents(system.db.booking, journey.bookingId)).toEqual(before)
    expect(await outboxCount(system.db.booking, journey.bookingId, 'supplier.confirm')).toBe(1)
    const { bookings } = await system.supplier.reservations()
    expect(bookings.filter((booking) => booking.idempotencyKey === journey.bookingId)).toHaveLength(
      1,
    )

    await assertInvariants(system, [journey.bookingId])
  })

  test('pembayaran terlambat yang diterbitkan ulang tidak menghasilkan perintah refund kedua', async () => {
    // Uji di atas dijaga DUA lapis: catatan pesan terkonsumsi, dan mesin
    // keadaan (`paymentId` yang sama pada pemesanan PAID/CONFIRMED dijawab
    // `duplicate` oleh on-payment.ts). Suntikan "consumed_messages tidak
    // ditulis" tidak menggagalkannya — ditemukan Step 20. Uji ini menyasar
    // pesan yang HANYA dijaga catatan itu (README, "Konsumsi idempoten"):
    // pembayaran yang tiba setelah hold kedaluwarsa. EXPIRED tidak punya
    // transisi untuk ditolak, jadi setiap pembacaan akan menulis perintah
    // refund baru.
    const journey = await held(system)
    await waitForStatus(system, journey, 'EXPIRED', system.infra.mockSupplier.holdTtlMs + 15_000)
    const paymentId = await pay(system, journey)
    await waitFor(
      `refund pembayaran terlambat ${paymentId} berhasil`,
      async () => await refundsOf(system.db.payment, paymentId),
      (refunds) => refunds.some((refund) => refund.status === 'SUCCEEDED'),
    )
    const late = await kafka.waitForEvent('payment.succeeded', journey.bookingId)

    await kafka.republish(late.raw)

    await waitFor(
      `booking-service menolak ulang ${late.eventId} sebagai duplikat`,
      async () => await Promise.resolve(duplicateReactions(system, late.eventId)),
      (count) => count >= 1,
    )
    expect(await outboxCount(system.db.booking, journey.bookingId, 'payment.refund')).toBe(1)
    expect(await refundsOf(system.db.payment, paymentId)).toHaveLength(1)
    expect((await bookingStatus(system, journey)).status).toBe('EXPIRED')

    await assertInvariants(system, [journey.bookingId])
  })
})

describe('idempotency key yang sama secara serentak', () => {
  test('dua price check serentak dengan kunci sama menghasilkan satu pemesanan', async () => {
    const userId = randomUUID()
    const idempotencyKey = `saga-it-${randomUUID()}`
    const stay = await nextStay(system)
    const ratePlan = await system.supplier.findSkyRatePlan(stay)
    const body = priceCheckBody({
      idempotencyKey,
      ratePlan,
      stay,
      displayed: { amountMinor: 1, currency: 'IDR' },
    })

    const answers = await Promise.all(
      Array.from(
        { length: 2 },
        async () =>
          await call('POST', `${system.booking.url}/bookings/price-check`, { userId, body }),
      ),
    )

    expect(answers.map((answer) => answer.status)).toEqual([200, 200])
    const ids = new Set(answers.map((answer) => String(data(answer).id)))
    expect(ids.size).toBe(1)
    expect(await bookingsOfUser(system.db.booking, userId)).toHaveLength(1)

    // Pemesanan itu dibawa sampai tuntas, supaya invarian berlaku atasnya.
    const bookingId = [...ids][0] ?? ''
    const total = await acceptPrice(system, userId, bookingId)
    const journey: Journey = { userId, idempotencyKey, bookingId, stay, ratePlan, total }
    expect((await placeHold(system, journey)).status).toBe(200)
    await pay(system, journey)
    await waitForStatus(system, journey, 'CONFIRMED')
    expect((await bookingRow(system.db.booking, bookingId))?.userId).toBe(userId)

    await assertInvariants(system, [bookingId])
  })
})

function duplicateReactions(sys: System, eventId: string): number {
  return sys.booking.logs.filter(
    (line) => line.raw.eventId === eventId && line.raw.outcome === 'duplicate',
  ).length
}
