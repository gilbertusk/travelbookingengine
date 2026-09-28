import { describe, expect, test } from 'vitest'
import {
  awaitOrphanRefund,
  awaitReply,
  beginCompensation,
  beginSaga,
  compensationAttemptFailed,
  completeSaga,
  directCompensationDone,
  enterStep,
  isSagaFinished,
  orphanRefundSaga,
  refundSettled,
  restartSaga,
  toReview,
  type CompensationStart,
  type SagaState,
} from './saga-state.js'

const BOOKING = '3f0c8a52-6d1e-4c3b-9a7f-0e1d2c3b4a59'
const T0 = new Date('2026-10-01T03:00:00.000Z')
const LEASE = 60_000
const REFUND_TIMEOUT = 15 * 60_000

function at(seconds: number): Date {
  return new Date(T0.getTime() + seconds * 1_000)
}

function start(overrides: Partial<CompensationStart> = {}): CompensationStart {
  return {
    through: 'awaitPayment',
    stoppedAt: 'confirmSupplier',
    at: at(10),
    leaseMs: LEASE,
    awaitRefundTimeoutMs: REFUND_TIMEOUT,
    reason: 'supplier menolak konfirmasi',
    ...overrides,
  }
}

/** Saga yang sudah menunggu jawaban konfirmasi supplier — lewat perpindahan sungguhan. */
function waitingForSupplier(): SagaState {
  const held = awaitReply(
    enterStep(beginSaga(BOOKING, T0, LEASE), 'holdSupplier', at(1), LEASE),
    'awaitPayment',
    at(2),
    undefined,
  )

  return awaitReply(held, 'confirmSupplier', at(3), at(600))
}

describe('saga maju', () => {
  test('dimulai di hold lokal, dengan niat tercatat SEBELUM kursi diambil', () => {
    const saga = beginSaga(BOOKING, T0, LEASE)

    expect(saga).toMatchObject({ phase: 'running', step: 'holdLocal', stepStatus: 'started' })
    expect(saga.phase === 'running' && saga.leasedUntil).toEqual(at(60))
  })

  test('setiap perpindahan menaikkan versi', () => {
    const saga = beginSaga(BOOKING, T0, LEASE)

    expect(enterStep(saga, 'holdSupplier', at(1), LEASE).version).toBe(saga.version + 1)
  })

  test('menunggu jawaban melepas sewa dan memasang batas waktu', () => {
    const saga = waitingForSupplier()

    expect(saga).toMatchObject({ phase: 'running', stepStatus: 'waiting', deadlineAt: at(600) })
    expect(saga.phase === 'running' && saga.leasedUntil).toBeUndefined()
  })

  test('selesai di langkah voucher', () => {
    const saga = completeSaga(waitingForSupplier(), at(20))

    expect(saga).toMatchObject({ phase: 'completed', step: 'issueVoucher' })
    expect(isSagaFinished(saga)).toBe(true)
  })

  test('saga yang berjalan belum selesai', () => {
    expect(isSagaFinished(waitingForSupplier())).toBe(false)
  })
})

describe('memulai ulang hold', () => {
  test('hold yang dikompensasi dapat dicoba ulang pengguna, dengan hitungan percobaannya', () => {
    const aborted = beginCompensation(
      beginSaga(BOOKING, T0, LEASE),
      start({
        through: undefined,
        stoppedAt: 'holdLocal',
      }),
    ).saga

    const restarted = restartSaga(aborted, at(30), LEASE)

    expect(restarted).toMatchObject({ phase: 'running', step: 'holdLocal', attempts: 1 })
    expect(restarted?.lastError).toBeUndefined()
  })

  test('hold yang gagal di supplier juga dapat dicoba ulang', () => {
    const atSupplier = enterStep(beginSaga(BOOKING, T0, LEASE), 'holdSupplier', at(1), LEASE)
    const aborted = beginCompensation(
      atSupplier,
      start({ through: 'holdLocal', stoppedAt: 'holdSupplier' }),
    )
    const released = directCompensationDone(aborted.saga, at(11), LEASE)

    expect(restartSaga(released, at(30), LEASE)).toMatchObject({ phase: 'running', attempts: 1 })
  })

  test('saga yang masih berjalan tidak dapat dimulai ulang — dua hold untuk satu pemesanan', () => {
    expect(restartSaga(beginSaga(BOOKING, T0, LEASE), at(1), LEASE)).toBeUndefined()
  })

  test('saga yang terkompensasi SETELAH pembayaran tidak dapat dimulai ulang', () => {
    const cancelled = beginCompensation(
      waitingForSupplier(),
      start({
        through: 'holdSupplier',
        stoppedAt: 'awaitPayment',
      }),
    )
    const released = directCompensationDone(cancelled.saga, at(11), LEASE)

    expect(released.phase).toBe('compensated')
    expect(restartSaga(released, at(30), LEASE)).toBeUndefined()
  })
})

describe('kompensasi', () => {
  test('US-03: refund diminta lewat outbox dan hold lokal menjadi kompensasi langsung berikutnya', () => {
    const { saga, outbox } = beginCompensation(waitingForSupplier(), start())

    expect(outbox).toEqual(['refundPayment'])
    expect(saga).toMatchObject({
      phase: 'compensating',
      step: 'confirmSupplier',
      compensating: 'holdLocal',
      refundDueBy: at(10 + REFUND_TIMEOUT / 1_000),
      lastError: 'supplier menolak konfirmasi',
    })
  })

  test('hold lokal terlepas, refund masih ditunggu: saga belum terkompensasi', () => {
    const { saga } = beginCompensation(waitingForSupplier(), start())

    const released = directCompensationDone(saga, at(11), LEASE)

    expect(released).toMatchObject({ phase: 'compensating', compensating: undefined })
    expect(released.phase === 'compensating' && released.leasedUntil).toBeUndefined()
  })

  test('refund dikonfirmasi setelah hold terlepas: saga terkompensasi', () => {
    const { saga } = beginCompensation(waitingForSupplier(), start())

    const done = refundSettled(directCompensationDone(saga, at(11), LEASE), at(40))

    expect(done.phase).toBe('compensated')
    expect(isSagaFinished(done)).toBe(true)
  })

  test('refund dikonfirmasi SEBELUM hold terlepas: hold tetap menjadi penunjuk', () => {
    const { saga } = beginCompensation(waitingForSupplier(), start())

    const settled = refundSettled(saga, at(11))

    expect(settled).toMatchObject({
      phase: 'compensating',
      compensating: 'holdLocal',
      refundDueBy: undefined,
    })
  })

  test('tanpa efek apa pun, kompensasi langsung selesai', () => {
    const { saga, outbox } = beginCompensation(
      beginSaga(BOOKING, T0, LEASE),
      start({
        through: undefined,
        stoppedAt: 'holdLocal',
      }),
    )

    expect(outbox).toEqual([])
    expect(saga.phase).toBe('compensated')
  })

  test('penunjuk yang sudah habis tidak berubah lagi', () => {
    const { saga } = beginCompensation(waitingForSupplier(), start())
    const released = directCompensationDone(saga, at(11), LEASE)

    expect(directCompensationDone(released, at(12), LEASE)).toBe(released)
  })

  test('penyelesaian refund pada saga yang tidak berkompensasi tidak mengubah apa pun', () => {
    const saga = waitingForSupplier()

    expect(refundSettled(saga, at(11))).toBe(saga)
  })

  test('kompensasi langsung yang gagal dijadwalkan ulang setelah jeda', () => {
    const { saga } = beginCompensation(waitingForSupplier(), start())

    const failed = compensationAttemptFailed(saga, at(11), 'redis mati', {
      maxAttempts: 3,
      retryDelayMs: 5_000,
    })

    expect(failed).toMatchObject({ phase: 'compensating', attempts: 1, lastError: 'redis mati' })
    expect(failed.phase === 'compensating' && failed.leasedUntil).toEqual(at(16))
  })

  test('kompensasi yang gagal sampai percobaannya habis diserahkan ke manusia, bukan diabaikan', () => {
    const policy = { maxAttempts: 2, retryDelayMs: 5_000 }
    const { saga } = beginCompensation(waitingForSupplier(), start())

    const once = compensationAttemptFailed(saga, at(11), 'redis mati', policy)
    const twice = compensationAttemptFailed(once, at(20), 'redis masih mati', policy)

    expect(twice).toMatchObject({
      phase: 'review',
      compensation: 'failed',
      lastError: 'redis masih mati',
    })
  })

  test('kegagalan kompensasi pada saga yang tidak berkompensasi tidak mengubah apa pun', () => {
    const saga = waitingForSupplier()

    expect(compensationAttemptFailed(saga, at(11), 'x', { maxAttempts: 1, retryDelayMs: 1 })).toBe(
      saga,
    )
  })
})

describe('peninjauan manusia', () => {
  test('status yang tidak pasti berhenti TANPA kompensasi', () => {
    const saga = toReview(waitingForSupplier(), at(20), 'skipped', 'status supplier tidak pasti')

    expect(saga).toMatchObject({ phase: 'review', compensation: 'skipped' })
    expect(isSagaFinished(saga)).toBe(true)
  })
})

describe('refund untuk pembayaran yang tidak dapat diterima', () => {
  const due = at(900)

  test('saga yang sudah terkompensasi membuka diri untuk menunggu refund itu', () => {
    const { saga } = beginCompensation(
      waitingForSupplier(),
      start({ through: 'holdSupplier', stoppedAt: 'awaitPayment' }),
    )
    const compensated = directCompensationDone(saga, at(11), LEASE)

    expect(awaitOrphanRefund(compensated, at(20), due, 'pembayaran terlambat')).toMatchObject({
      phase: 'compensating',
      compensating: undefined,
      refundDueBy: due,
    })
  })

  test('saga yang masih melepas hold ikut menunggu refund', () => {
    const { saga } = beginCompensation(
      waitingForSupplier(),
      start({ through: 'holdSupplier', stoppedAt: 'awaitPayment' }),
    )

    expect(awaitOrphanRefund(saga, at(20), due, 'pembayaran terlambat')).toMatchObject({
      phase: 'compensating',
      compensating: 'holdLocal',
      refundDueBy: due,
    })
  })

  test('saga yang sudah menunggu refund lain tidak dapat menjaga yang kedua', () => {
    const { saga } = beginCompensation(waitingForSupplier(), start())

    expect(awaitOrphanRefund(saga, at(20), due, 'pembayaran kedua')).toBeUndefined()
  })

  test('saga yang diserahkan ke manusia tidak dibuka lagi', () => {
    const review = toReview(waitingForSupplier(), at(20), 'skipped', 'tidak pasti')

    expect(awaitOrphanRefund(review, at(21), due, 'pembayaran kedua')).toBeUndefined()
  })

  test('pemesanan tanpa saga memperoleh saga yang hanya menunggu refund', () => {
    expect(orphanRefundSaga(BOOKING, at(20), due, 'dibayar setelah dibatalkan')).toMatchObject({
      phase: 'compensating',
      step: 'awaitPayment',
      compensating: undefined,
      refundDueBy: due,
      version: 1,
    })
  })
})
