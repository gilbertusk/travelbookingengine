import { createMessage, type CommandPayload } from '@tbe/event-contracts'
import {
  DEAD_LETTER_EXCHANGE,
  RETRY_COUNT_HEADER,
  RETRY_EXCHANGE,
  RETRY_TIERS,
  createCommandConsumer,
} from '@tbe/messaging'
import { describe, expect, test } from 'vitest'
import {
  LOG_LEVELS,
  TEST_BOOKING_ID,
  TEST_PAYMENT_ID,
  givenPendingPayment,
  givenSucceededPayment,
  harness,
  recordingPublisher,
  scriptedGateway,
  type Harness,
} from '../testing/fakes.js'
import { handleRefund } from './refund-command.js'

const REQUEST_ID = '33333333-3333-4333-8333-333333333333'

function payload(
  overrides: Partial<CommandPayload<'payment.refund'>> = {},
): CommandPayload<'payment.refund'> {
  return {
    refundRequestId: REQUEST_ID,
    paymentId: TEST_PAYMENT_ID,
    bookingId: TEST_BOOKING_ID,
    amount: { amountMinor: 1_250_000, currency: 'IDR' },
    reason: 'supplier_failed',
    ...overrides,
  }
}

/**
 * Perintah dijalankan melalui pembungkus consumer YANG SESUNGGUHNYA dari
 * @tbe/messaging, bukan melalui tiruan kebijakan percobaan ulang.
 *
 * Definisi Selesai "refund gagal permanen mencatat galat tingkat error, bukan
 * sekadar peringatan" adalah tentang perilaku pembungkus itu. Menguji tiruan
 * kebijakan buatan sendiri akan membuktikan bahwa tiruannya benar.
 */
async function deliver(
  world: Harness,
  attempts: number,
  overrides: Partial<CommandPayload<'payment.refund'>> = {},
): Promise<{ outcome: string; published: ReturnType<typeof recordingPublisher>['published'] }> {
  const publisher = recordingPublisher()
  const message = createMessage({
    eventType: 'payment.refund' as const,
    payload: payload(overrides),
  })

  const consumer = createCommandConsumer({
    command: 'payment.refund',
    publisher,
    logger: world.deps.logger,
    handle: handleRefund(world.deps),
  })

  const outcome = await consumer({
    content: Buffer.from(JSON.stringify(message), 'utf8'),
    headers: attempts === 0 ? {} : { [RETRY_COUNT_HEADER]: attempts },
    routingKey: 'payment.refund',
  })

  return { outcome, published: publisher.published }
}

describe('perintah yang selesai', () => {
  test('refund berhasil di-ack tanpa penerbitan ulang', async () => {
    const world = harness()
    await givenSucceededPayment(world)

    const { outcome, published } = await deliver(world, 0)

    expect(outcome).toBe('ack')
    expect(published).toHaveLength(0)
    expect(world.payments.rows.get(TEST_PAYMENT_ID)?.status).toBe('REFUNDED')
  })

  test('perintah yang diulang untuk refund yang sudah berhasil di-ack tanpa suara', async () => {
    const world = harness()
    await givenSucceededPayment(world)

    await deliver(world, 0)
    const { outcome, published } = await deliver(world, 0)

    // Idempoten: tidak ada panggilan kedua ke penyedia, dan tidak ada yang
    // masuk dead letter untuk pekerjaan yang sudah selesai.
    expect(outcome).toBe('ack')
    expect(published).toHaveLength(0)
    expect(world.gateway.refunds).toHaveLength(1)
  })

  test('pembayaran yang tidak dapat direfund di-ack, bukan dilempar', async () => {
    const world = harness()
    await givenPendingPayment(world)

    const { outcome, published } = await deliver(world, 0)

    // Saga yang mengompensasi pemesanan yang pembayarannya memang gagal akan
    // mengirim perintah ini. Tidak ada yang perlu dikembalikan, dan dead letter
    // yang penuh oleh pekerjaan yang tidak ada membuat dead letter berhenti
    // dibaca orang.
    expect(outcome).toBe('ack')
    expect(published).toHaveLength(0)
  })
})

describe('kegagalan sementara', () => {
  test('penyedia yang tidak dapat dihubungi masuk antrian tunda tingkat pertama', async () => {
    const world = harness({ gateway: scriptedGateway({ refund: [{ kind: 'unavailable' }] }) })
    await givenSucceededPayment(world)

    const { outcome, published } = await deliver(world, 0)

    expect(outcome).toBe('ack')
    expect(published).toHaveLength(1)
    expect(published[0]?.exchange).toBe(RETRY_EXCHANGE)
    expect(published[0]?.routingKey).toContain(RETRY_TIERS[0]?.name ?? 't1')
  })

  test('percobaan yang belum habis dicatat sebagai peringatan, bukan galat', async () => {
    const world = harness({ gateway: scriptedGateway({ refund: [{ kind: 'unavailable' }] }) })
    await givenSucceededPayment(world)

    await deliver(world, 1)

    const dariPembungkus = world.lines.filter((line) => line.msg.includes('dicoba ulang'))
    expect(dariPembungkus.some((line) => line.level === LOG_LEVELS.warn)).toBe(true)
  })

  /**
   * Definisi Selesai: "refund gagal permanen mencatat galat tingkat error, bukan
   * sekadar peringatan".
   *
   * Tiga tingkat percobaan sudah habis, jadi perintah masuk dead letter. Uang
   * pengguna tertahan dan tidak ada lagi yang akan mencoba mengembalikannya —
   * itu keadaan yang menuntut tindakan manusia, dan peringatan tidak menuntut
   * apa pun.
   */
  test('percobaan yang habis masuk dead letter dan dicatat sebagai galat', async () => {
    const world = harness({ gateway: scriptedGateway({ refund: [{ kind: 'unavailable' }] }) })
    await givenSucceededPayment(world)

    const { outcome, published } = await deliver(world, RETRY_TIERS.length)

    expect(outcome).toBe('ack')
    expect(published[0]?.exchange).toBe(DEAD_LETTER_EXCHANGE)

    const deadLetterLine = world.lines.find((line) => line.msg.includes('dead letter'))
    expect(deadLetterLine?.level).toBe(LOG_LEVELS.error)
    expect(deadLetterLine?.reason).toBe('exhausted')
  })
})

describe('kegagalan permanen', () => {
  test('penolakan permanen penyedia langsung masuk dead letter tanpa percobaan ulang', async () => {
    const world = harness({
      gateway: scriptedGateway({ refund: [{ kind: 'rejected', reason: 'terlalu lama' }] }),
    })
    await givenSucceededPayment(world)

    const { published } = await deliver(world, 0)

    // Tidak ada gunanya mencoba lagi: jawabannya tidak akan berubah, dan setiap
    // percobaan menunda perintah lain di belakangnya.
    expect(published[0]?.exchange).toBe(DEAD_LETTER_EXCHANGE)

    const deadLetterLine = world.lines.find((line) => line.msg.includes('dead letter'))
    expect(deadLetterLine?.level).toBe(LOG_LEVELS.error)
    expect(deadLetterLine?.reason).toBe('not_retryable')
  })

  test('nilai yang melebihi pembayaran langsung masuk dead letter', async () => {
    const world = harness()
    await givenSucceededPayment(world)

    const { published } = await deliver(world, 0, {
      amount: { amountMinor: 9_000_000, currency: 'IDR' },
    })

    expect(published[0]?.exchange).toBe(DEAD_LETTER_EXCHANGE)
    expect(world.gateway.refunds).toHaveLength(0)
  })

  test('pembayaran yang tidak dikenal masuk dead letter', async () => {
    const world = harness()

    const { published } = await deliver(world, 0)

    expect(published[0]?.exchange).toBe(DEAD_LETTER_EXCHANGE)
  })
})

describe('perintah cacat', () => {
  test('perintah yang tidak sesuai kontrak masuk dead letter tanpa menyentuh pembayaran', async () => {
    const world = harness()
    await givenSucceededPayment(world)
    const publisher = recordingPublisher()

    const consumer = createCommandConsumer({
      command: 'payment.refund',
      publisher,
      logger: world.deps.logger,
      handle: handleRefund(world.deps),
    })

    const outcome = await consumer({
      content: Buffer.from(JSON.stringify({ eventType: 'payment.refund' }), 'utf8'),
      headers: {},
      routingKey: 'payment.refund',
    })

    expect(outcome).toBe('ack')
    expect(publisher.published[0]?.exchange).toBe(DEAD_LETTER_EXCHANGE)
    expect(world.gateway.refunds).toHaveLength(0)
    expect(world.payments.rows.get(TEST_PAYMENT_ID)?.status).toBe('SUCCEEDED')
  })
})
