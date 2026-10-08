import { getCorrelationId } from '@tbe/shared-kernel'
import { describe, expect, test } from 'vitest'
import { RATE_LIMIT_DEFER_MS, RETRY_DELAYS_MS } from '../domain/delivery.js'
import {
  BOOKING_ID,
  START,
  USER,
  VOUCHER_PDF,
  confirmationRequest,
  snapshot,
  world,
  type World,
} from '../testing/fakes.js'
import { deliverDue } from './deliver.js'

async function requested(w: World, request = confirmationRequest()): Promise<void> {
  await w.notifications.request(request, w.clock.value)
}

function only(w: World) {
  const row = w.notifications.rows[0]
  if (row === undefined) throw new Error('tidak ada baris')
  return row
}

describe('penghantaran surel', () => {
  test('surel konfirmasi terkirim dengan voucher terlampir, dan userId dilengkapi dari pemesanan', async () => {
    const w = world()
    await requested(w)

    const processed = await deliverDue(w.deps)

    expect(processed).toBe(1)
    expect(w.sender.sent).toHaveLength(1)
    const email = w.sender.sent[0]
    expect(email?.to).toBe('sari@example.com')
    expect(email?.attachments).toEqual([
      { filename: 'e-voucher.pdf', contentType: 'application/pdf', content: VOUCHER_PDF },
    ])
    expect(only(w)).toMatchObject({ status: 'SENT', sentAt: START, userId: USER })
    expect(w.metrics.recorded).toEqual([{ type: 'booking_confirmed', outcome: 'sent' }])
  })

  test('surel selain konfirmasi tidak membawa lampiran', async () => {
    const w = world({ snapshots: [snapshot({ status: 'FAILED', supplierRef: null })] })
    await requested(
      w,
      confirmationRequest({
        dedupeKey: `booking_failed:${BOOKING_ID}`,
        context: { type: 'booking_failed' },
      }),
    )

    await deliverDue(w.deps)

    expect(w.sender.sent[0]?.attachments).toEqual([])
  })

  test('catatan pengiriman tidak menyimpan alamat surel, hanya kuncinya', async () => {
    const w = world()
    await requested(w)

    await deliverDue(w.deps)

    expect(JSON.stringify(w.notifications.rows)).not.toContain('sari@example.com')
    expect(only(w).recipientKey).toMatch(/^[0-9a-f]{64}$/)
  })

  test('voucher yang belum terbit membuat surel konfirmasi MENUNGGU, bukan terkirim tanpa voucher', async () => {
    const w = world({ voucherReady: false })
    await requested(w)

    await deliverDue(w.deps)

    expect(w.sender.sent).toEqual([])
    expect(only(w)).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      lastError: 'voucher_not_ready',
      nextAttemptAt: new Date(START.getTime() + (RETRY_DELAYS_MS[0] ?? 0)),
    })
  })

  test('pemberitahuan yang belum jatuh tempo tidak diambil', async () => {
    const w = world({ voucherReady: false })
    await requested(w)
    await deliverDue(w.deps)
    w.vouchers.documents.set(BOOKING_ID, VOUCHER_PDF)

    expect(await deliverDue(w.deps)).toBe(0)
    w.advance(RETRY_DELAYS_MS[0] ?? 0)
    expect(await deliverDue(w.deps)).toBe(1)
    expect(w.sender.sent).toHaveLength(1)
  })
})

describe('kegagalan yang permanen tidak dicoba ulang', () => {
  test('alamat tidak sah tidak pernah sampai ke server SMTP', async () => {
    const w = world({
      snapshots: [snapshot({ leadGuest: { fullName: 'Sari', email: 'sari@localhost' } })],
    })
    await requested(w)

    await deliverDue(w.deps)
    w.advance(RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0))
    await deliverDue(w.deps)

    expect(w.sender.sent).toEqual([])
    expect(only(w)).toMatchObject({ status: 'FAILED', lastError: 'invalid_address', attempts: 0 })
  })

  test('penolakan permanen dari server SMTP (5xx) tidak dicoba ulang', async () => {
    const w = world()
    w.sender.script.push({ kind: 'permanent', code: 'smtp_550' })
    await requested(w)

    await deliverDue(w.deps)
    w.advance(60 * 60_000)
    await deliverDue(w.deps)

    expect(only(w)).toMatchObject({ status: 'FAILED', lastError: 'smtp_550' })
    expect(w.metrics.recorded).toEqual([{ type: 'booking_confirmed', outcome: 'failed' }])
  })

  test('pemesanan yang tidak ada dilewati', async () => {
    const w = world({ snapshots: [] })
    await requested(w)

    await deliverDue(w.deps)

    expect(only(w)).toMatchObject({ status: 'SKIPPED', lastError: 'booking_not_found' })
  })

  test('surel yang sudah tidak benar dilewati, bukan dikirim', async () => {
    const w = world({ snapshots: [snapshot({ status: 'CONFIRMED' })] })
    await requested(
      w,
      confirmationRequest({
        dedupeKey: `manual_review:${BOOKING_ID}`,
        context: { type: 'manual_review', concern: 'room' },
      }),
    )

    await deliverDue(w.deps)

    expect(w.sender.sent).toEqual([])
    expect(only(w)).toMatchObject({ status: 'SKIPPED', lastError: 'outdated:CONFIRMED' })
  })
})

describe('kegagalan sementara: retry berjenjang lalu dead letter', () => {
  test('server SMTP yang tidak menjawab dicoba lagi sesuai jenjang', async () => {
    const w = world()
    w.sender.script.push({ kind: 'transient', code: 'smtp_421' })
    await requested(w)

    await deliverDue(w.deps)

    expect(only(w)).toMatchObject({ status: 'PENDING', attempts: 1, lastError: 'smtp_421' })
    w.advance(RETRY_DELAYS_MS[0] ?? 0)
    await deliverDue(w.deps)
    expect(only(w).status).toBe('SENT')
  })

  test('booking-service yang mati adalah kegagalan sementara', async () => {
    const w = world()
    w.bookings.failing = true
    await requested(w)

    await deliverDue(w.deps)

    expect(only(w)).toMatchObject({ status: 'PENDING', attempts: 1, lastError: 'upstream_error' })
  })

  test('galat tak dikenal dari pengirim diperlakukan sebagai sementara', async () => {
    const w = world()
    w.sender.throwing = true
    await requested(w)

    await deliverDue(w.deps)

    expect(only(w)).toMatchObject({ status: 'PENDING', attempts: 1 })
  })

  test('sesudah jenjang terakhir habis, pemberitahuan masuk dead letter', async () => {
    const w = world()
    w.sender.throwing = true
    await requested(w)

    for (const delay of [0, ...RETRY_DELAYS_MS]) {
      w.advance(delay)
      await deliverDue(w.deps)
    }

    expect(only(w)).toMatchObject({ status: 'DEAD', attempts: RETRY_DELAYS_MS.length + 1 })
    expect(w.metrics.recorded.at(-1)).toEqual({ type: 'booking_confirmed', outcome: 'dead' })
    w.advance(24 * 60 * 60_000)
    expect(await deliverDue(w.deps)).toBe(0)
  })
})

describe('pembatasan laju per penerima', () => {
  test('surel yang melewati batas ditunda tanpa menghabiskan percobaan', async () => {
    const w = world({ ratePerHour: 1 })
    await requested(w)
    await requested(
      w,
      confirmationRequest({
        dedupeKey: 'command:018f2a1c-0000-7000-8000-0000000c0001',
        source: 'command',
      }),
    )

    await deliverDue(w.deps)

    expect(w.sender.sent).toHaveLength(1)
    const deferred = w.notifications.rows[1]
    expect(deferred).toMatchObject({
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: new Date(START.getTime() + RATE_LIMIT_DEFER_MS),
    })
  })

  test('surel yang ditunda terkirim sesudah jendelanya lewat', async () => {
    const w = world({ ratePerHour: 1 })
    await requested(w)
    await requested(w, confirmationRequest({ dedupeKey: 'command:c2', source: 'command' }))
    await deliverDue(w.deps)

    w.advance(61 * 60_000)
    await deliverDue(w.deps)

    expect(w.sender.sent).toHaveLength(2)
  })
})

describe('sewa dan baris rusak', () => {
  test('baris yang sewanya habis berulang kali berhenti di DEAD tanpa dicoba lagi', async () => {
    const w = world()
    await requested(w)
    for (let crash = 0; crash <= RETRY_DELAYS_MS.length; crash += 1) {
      await w.notifications.claimNext(w.clock.value, 1_000)
      w.advance(1_001)
    }

    await deliverDue(w.deps)

    expect(w.sender.sent).toEqual([])
    expect(only(w)).toMatchObject({ status: 'DEAD', lastError: 'lease_exhausted' })
  })

  test('hasil penghantar yang sewanya sudah diambil alih dibuang', async () => {
    const w = world()
    await requested(w)
    const stale = await w.notifications.claimNext(w.clock.value, 1_000)
    if (stale === undefined) throw new Error('tidak terambil')
    w.advance(1_001)
    await deliverDue(w.deps)

    const isRecorded = await w.notifications.settle(
      stale,
      { kind: 'skipped', reason: 'x' },
      w.clock.value,
    )

    expect(isRecorded).toBe(false)
    expect(only(w).status).toBe('SENT')
  })

  test('surel konfirmasi yang DEAD karena voucher terlambat hidup lagi saat voucher terbit', async () => {
    const w = world({ voucherReady: false })
    await requested(w)
    for (const delay of [0, ...RETRY_DELAYS_MS]) {
      w.advance(delay)
      await deliverDue(w.deps)
    }
    expect(only(w).status).toBe('DEAD')

    w.vouchers.documents.set(BOOKING_ID, VOUCHER_PDF)
    await requested(w)
    await deliverDue(w.deps)

    expect(w.sender.sent).toHaveLength(1)
  })

  test('duplikat tidak melompati jenjang tunda kegagalan SMTP', async () => {
    const w = world()
    w.sender.script.push({ kind: 'transient', code: 'smtp_421' })
    await requested(w)
    await deliverDue(w.deps)

    await requested(w)

    expect(await deliverDue(w.deps)).toBe(0)
  })
})

describe('penghantar', () => {
  test('setiap pemberitahuan dikirim di dalam correlationId pemicunya sendiri', async () => {
    const w = world()
    const seen: (string | undefined)[] = []
    const lookup = w.bookings.notificationSource.bind(w.bookings)
    w.bookings.notificationSource = async (bookingId) => {
      seen.push(getCorrelationId())
      return await lookup(bookingId)
    }
    await requested(w, confirmationRequest({ correlationId: 'corr-a' }))
    await requested(w, confirmationRequest({ dedupeKey: 'command:c1', correlationId: 'corr-b' }))

    await deliverDue(w.deps)

    expect(seen).toEqual(['corr-a', 'corr-b'])
  })

  test('satu putaran mengambil paling banyak sebesar batch', async () => {
    const w = world()
    for (let index = 0; index < 12; index += 1) {
      await requested(
        w,
        confirmationRequest({ dedupeKey: `command:c${String(index)}`, source: 'command' }),
      )
    }

    expect(await deliverDue(w.deps)).toBe(10)
  })

  test('kegagalan pengiriman tidak pernah dilempar keluar dari penghantar', async () => {
    const w = world()
    w.sender.throwing = true
    w.bookings.failing = true
    await requested(w)

    await expect(deliverDue(w.deps)).resolves.toBe(1)
  })
})
