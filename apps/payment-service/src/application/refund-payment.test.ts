import { money } from '@tbe/money'
import { describe, expect, test } from 'vitest'
import {
  LOG_LEVELS,
  TEST_BOOKING_ID,
  TEST_PAYMENT_ID,
  givenPendingPayment,
  givenSucceededPayment,
  harness,
  scriptedGateway,
  type Harness,
} from '../testing/fakes.js'
import { refundPayment, type RefundCommand } from './refund-payment.js'

function command(overrides: Partial<RefundCommand> = {}): RefundCommand {
  return {
    refundRequestId: '33333333-3333-4333-8333-333333333333',
    paymentId: TEST_PAYMENT_ID,
    bookingId: TEST_BOOKING_ID,
    amount: money(1_250_000, 'IDR'),
    reason: 'supplier_failed',
    ...overrides,
  }
}

function refundCalls(world: Harness): number {
  return world.gateway.refunds.length
}

describe('refund yang berhasil', () => {
  test('dana dikembalikan, pembayaran menjadi REFUNDED, peristiwa terbit', async () => {
    const world = harness()
    await givenSucceededPayment(world)

    const result = await refundPayment(world.deps, command())

    expect(result.kind).toBe('refunded')
    expect(world.payments.rows.get(TEST_PAYMENT_ID)?.status).toBe('REFUNDED')
    expect(world.events.published).toHaveLength(1)
    expect(world.events.published[0]).toMatchObject({
      type: 'refunded',
      paymentId: TEST_PAYMENT_ID,
      bookingId: TEST_BOOKING_ID,
      amount: money(1_250_000, 'IDR'),
    })
  })

  test('refund sebagian membuat pembayaran PARTIALLY_REFUNDED', async () => {
    const world = harness()
    await givenSucceededPayment(world)

    await refundPayment(world.deps, command({ amount: money(500_000, 'IDR') }))

    expect(world.payments.rows.get(TEST_PAYMENT_ID)?.status).toBe('PARTIALLY_REFUNDED')
  })

  test('peristiwa diterbitkan setelah keadaan tersimpan', async () => {
    const world = harness()
    await givenSucceededPayment(world)

    await refundPayment(world.deps, command())

    const requestId = '33333333-3333-4333-8333-333333333333'
    expect(world.effects).toEqual([
      `refund:${requestId}`,
      `gateway:refund:${requestId}`,
      `refund-update:${requestId}:SUCCEEDED`,
      'event:payment.refunded:generated-1',
    ])
  })

  test('pengenal permintaan diteruskan ke penyedia sebagai kunci idempotensinya', async () => {
    const world = harness()
    await givenSucceededPayment(world)

    await refundPayment(world.deps, command())

    // Penyedia punya idempotensinya sendiri. Meneruskan kunci yang sama membuat
    // percobaan ulang kita tidak menghasilkan refund kedua di sisi sana — dan
    // batasan UNIK kita tidak dapat melindungi apa pun yang sudah terjadi di
    // sistem orang lain.
    expect(world.gateway.refunds[0]?.requestId).toBe('33333333-3333-4333-8333-333333333333')
    expect(world.gateway.refunds[0]?.gatewayRef).toBe('midtrans-tx-1')
  })
})

describe('idempotensi terhadap pengenal permintaan', () => {
  test('perintah kedua dengan pengenal yang sama tidak mengembalikan dana dua kali', async () => {
    const world = harness()
    await givenSucceededPayment(world)

    const first = await refundPayment(world.deps, command())
    const second = await refundPayment(world.deps, command())

    expect(first.kind).toBe('refunded')
    expect(second.kind).toBe('already_done')
    expect(refundCalls(world)).toBe(1)
    // Dana keluar sekali, pengumumannya diulang (Step 25): pengumuman pertama
    // mungkin tidak pernah terbit, dan saga pembatalan menunggunya.
    expect(world.events.published.map((event) => event.type)).toEqual(['refunded', 'refunded'])
  })

  /**
   * Balapan, bukan percabangan — sama seperti uji sepuluh webhook serentak.
   * Yang memutuskan pemenang adalah batasan UNIK pada kolom `request_id`, yang
   * di sini ditiru palsuan repository.
   */
  test('sepuluh perintah refund serentak hanya memanggil penyedia sekali', async () => {
    const world = harness()
    await givenSucceededPayment(world)

    const results = await Promise.all(
      Array.from({ length: 10 }, () => refundPayment(world.deps, command())),
    )

    expect(refundCalls(world)).toBe(1)
    expect(results.filter((result) => result.kind === 'refunded')).toHaveLength(1)
    expect(world.events.published).toHaveLength(1)
    expect(world.payments.rows.get(TEST_PAYMENT_ID)?.status).toBe('REFUNDED')
  })

  /**
   * Bukti uji di atas tidak hampa: pada palsuan yang memakai pola "periksa dulu
   * baru tulis", dana yang sama dikembalikan berkali-kali.
   */
  test('uji balapan tidak hampa: pola periksa-dulu-baru-tulis mengembalikan dana berkali-kali', async () => {
    const world = harness({ racy: true })
    await givenSucceededPayment(world)

    await Promise.all(Array.from({ length: 10 }, () => refundPayment(world.deps, command())))

    expect(refundCalls(world)).toBeGreaterThan(1)
    expect(world.events.published.length).toBeGreaterThan(1)
  })

  test('pengenal permintaan berbeda mengembalikan dana lagi bila masih di dalam batas', async () => {
    const world = harness()
    await givenSucceededPayment(world)

    await refundPayment(world.deps, command({ amount: money(500_000, 'IDR') }))
    const second = await refundPayment(
      world.deps,
      command({
        refundRequestId: '44444444-4444-4444-8444-444444444444',
        amount: money(750_000, 'IDR'),
      }),
    )

    expect(second.kind).toBe('refunded')
    expect(world.payments.rows.get(TEST_PAYMENT_ID)?.status).toBe('REFUNDED')
  })
})

describe('penolakan', () => {
  /**
   * Batas total ditegakkan DOMAIN, sebelum penyedia dihubungi. Kalau
   * penjagaannya hanya batasan basis data, penolakannya datang setelah uangnya
   * keluar.
   */
  test('refund melebihi nilai pembayaran ditolak tanpa menghubungi penyedia', async () => {
    const world = harness()
    await givenSucceededPayment(world)

    const result = await refundPayment(world.deps, command({ amount: money(1_250_001, 'IDR') }))

    expect(result.kind).toBe('rejected')
    if (result.kind !== 'rejected') return
    expect(result.why).toBe('exceeds_total')
    expect(refundCalls(world)).toBe(0)
    expect(world.events.published).toHaveLength(0)
  })

  test('refund kedua yang melebihi sisa ditolak', async () => {
    const world = harness()
    await givenSucceededPayment(world)

    await refundPayment(world.deps, command({ amount: money(1_000_000, 'IDR') }))
    const second = await refundPayment(
      world.deps,
      command({
        refundRequestId: '44444444-4444-4444-8444-444444444444',
        amount: money(300_000, 'IDR'),
      }),
    )

    expect(second.kind).toBe('rejected')
    if (second.kind !== 'rejected') return
    expect(second.why).toBe('exceeds_total')
    expect(refundCalls(world)).toBe(1)
  })

  test('penolakan batas dicatat sebagai galat, bukan peringatan', async () => {
    const world = harness()
    await givenSucceededPayment(world)

    await refundPayment(world.deps, command({ amount: money(9_000_000, 'IDR') }))

    // Perintah refund datang dari saga kita sendiri. Nilai yang melebihi
    // pembayaran berarti ada cacat di hulu, dan itu butuh tindakan manusia.
    expect(world.lines.some((line) => line.level === LOG_LEVELS.error)).toBe(true)
  })

  test('pembayaran yang tidak dikenal dicatat sebagai galat', async () => {
    const world = harness()

    const result = await refundPayment(world.deps, command())

    expect(result.kind).toBe('rejected')
    if (result.kind !== 'rejected') return
    expect(result.why).toBe('unknown_payment')

    // Uang pengguna tertahan dan tidak ada yang akan mengembalikannya sendiri.
    const error = world.lines.find((line) => line.level === LOG_LEVELS.error)
    expect(error?.paymentId).toBe(TEST_PAYMENT_ID)
  })

  test('pembayaran yang belum berhasil tidak dapat direfund', async () => {
    const world = harness()
    await givenPendingPayment(world)

    const result = await refundPayment(world.deps, command())

    expect(result.kind).toBe('rejected')
    if (result.kind !== 'rejected') return
    expect(result.why).toBe('not_refundable')
    expect(refundCalls(world)).toBe(0)
  })
})

describe('kegagalan penyedia', () => {
  test('penyedia yang tidak dapat dihubungi menghasilkan hasil yang layak dicoba ulang', async () => {
    const world = harness({ gateway: scriptedGateway({ refund: [{ kind: 'unavailable' }] }) })
    await givenSucceededPayment(world)

    const result = await refundPayment(world.deps, command())

    expect(result.kind).toBe('retryable')

    // Refund tetap PENDING: ia sudah tercatat, dan kuotanya tetap terpakai
    // supaya perintah lain tidak ikut mengembalikan dana yang sama.
    const stored = world.payments.rows.get(TEST_PAYMENT_ID)
    expect(stored?.status).toBe('SUCCEEDED')
    expect(world.events.published).toHaveLength(0)
  })

  test('perintah ulang setelah penyedia tidak dapat dihubungi menuntaskan refund', async () => {
    const world = harness({
      gateway: scriptedGateway({
        refund: [{ kind: 'unavailable' }, { kind: 'refunded', providerRef: 'refund-ok' }],
      }),
    })
    await givenSucceededPayment(world)

    const first = await refundPayment(world.deps, command())
    expect(first.kind).toBe('retryable')

    const second = await refundPayment(world.deps, command())

    // Inilah yang membuat refund yang tertahan tidak terkunci selamanya oleh
    // pengenal permintaannya sendiri: refund yang masih PENDING dilanjutkan,
    // bukan ditolak sebagai duplikat.
    expect(second.kind).toBe('refunded')
    expect(refundCalls(world)).toBe(2)
    expect(world.payments.rows.get(TEST_PAYMENT_ID)?.status).toBe('REFUNDED')
  })

  test('penolakan permanen penyedia menandai refund FAILED dan membebaskan kuotanya', async () => {
    const world = harness({
      gateway: scriptedGateway({
        refund: [{ kind: 'rejected', reason: 'transaksi terlalu lama' }],
      }),
    })
    await givenSucceededPayment(world)

    const result = await refundPayment(world.deps, command())

    expect(result.kind).toBe('rejected')
    if (result.kind !== 'rejected') return
    expect(result.why).toBe('gateway_rejected')

    const stored = world.payments.rows.get(TEST_PAYMENT_ID)
    expect(stored?.status).toBe('SUCCEEDED')
    expect(world.events.published).toHaveLength(0)

    // Uang pengguna tertahan dan penyedia menolak mengembalikannya. Ini
    // memerlukan manusia, jadi tingkatnya error.
    expect(world.lines.some((line) => line.level === LOG_LEVELS.error)).toBe(true)
  })

  test('refund yang ditolak permanen dapat diminta ulang dengan pengenal baru', async () => {
    const world = harness({
      gateway: scriptedGateway({
        refund: [
          { kind: 'rejected', reason: 'ditolak' },
          { kind: 'refunded', providerRef: 'ok' },
        ],
      }),
    })
    await givenSucceededPayment(world)

    await refundPayment(world.deps, command())
    const retry = await refundPayment(
      world.deps,
      command({ refundRequestId: '44444444-4444-4444-8444-444444444444' }),
    )

    // Kuota kembali karena refund yang gagal tidak menahan apa pun — lihat
    // committedRefundTotal di domain/refund.ts.
    expect(retry.kind).toBe('refunded')
  })

  test('perintah ulang pada refund yang sudah gagal permanen tidak memanggil penyedia lagi', async () => {
    const world = harness({
      gateway: scriptedGateway({ refund: [{ kind: 'rejected', reason: 'ditolak' }] }),
    })
    await givenSucceededPayment(world)

    await refundPayment(world.deps, command())
    const again = await refundPayment(world.deps, command())

    expect(again.kind).toBe('rejected')
    if (again.kind !== 'rejected') return
    expect(again.why).toBe('already_failed')
    expect(refundCalls(world)).toBe(1)
  })
})
