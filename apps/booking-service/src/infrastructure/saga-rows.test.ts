import { describe, expect, test } from 'vitest'
import {
  awaitReply,
  beginCompensation,
  beginSaga,
  completeSaga,
  toReview,
  type SagaState,
} from '../domain/saga-state.js'
import type { SagaRow } from './booking-db.js'
import { fromSagaRow, toSagaRow } from './saga-rows.js'

/**
 * Fase saga tidak disimpan apa adanya; ia diturunkan dari pasangan kolom
 * step doc. Setiap fase harus kembali sebagai dirinya sendiri, dan setiap
 * pasangan yang tidak dikenal harus ditolak — pasangan yang ditebak menjadi
 * fase terdekat membuat pemulihan menjalankan kompensasi untuk saga yang
 * sudah selesai.
 */

const BOOKING = '3f0c8a52-6d1e-4c3b-9a7f-0e1d2c3b4a59'
const T0 = new Date('2026-10-01T03:00:00.000Z')
const T1 = new Date('2026-10-01T03:01:00.000Z')

const running = beginSaga(BOOKING, T0, 60_000)
const waiting = awaitReply(running, 'confirmSupplier', T1, new Date('2026-10-01T03:15:00.000Z'))
const compensating = beginCompensation(waiting, {
  through: 'awaitPayment',
  stoppedAt: 'confirmSupplier',
  at: T1,
  leaseMs: 60_000,
  awaitRefundTimeoutMs: 900_000,
  reason: 'ditolak',
}).saga

const PHASES: readonly [string, SagaState][] = [
  ['running/started', running],
  ['running/waiting', waiting],
  ['compensating', compensating],
  [
    'compensating tanpa refund',
    beginCompensation(running, {
      through: 'holdLocal',
      stoppedAt: 'holdSupplier',
      at: T1,
      leaseMs: 60_000,
      awaitRefundTimeoutMs: 900_000,
      reason: 'hold supplier gagal',
    }).saga,
  ],
  ['completed', completeSaga(waiting, T1)],
  [
    'compensated',
    beginCompensation(running, {
      through: undefined,
      stoppedAt: 'holdLocal',
      at: T1,
      leaseMs: 1,
      awaitRefundTimeoutMs: 1,
      reason: 'habis',
    }).saga,
  ],
  ['review/skipped', toReview(waiting, T1, 'skipped', 'tidak pasti')],
  ['review/failed', toReview(compensating, T1, 'failed', 'refund gagal')],
]

describe('keadaan saga pulang-pergi lewat baris', () => {
  test.each(PHASES)('%s', (_label, saga) => {
    expect(fromSagaRow(toSagaRow(saga, 'saga-1'))).toEqual(saga)
  })

  test('refund yang ditunggu disimpan di kolom batas waktu', () => {
    const row = toSagaRow(compensating, 'saga-1')

    expect(row).toMatchObject({
      stepStatus: 'failed',
      compensationStatus: 'running',
      compensatingStep: 'holdLocal',
      deadlineAt: compensating.phase === 'compensating' ? compensating.refundDueBy : undefined,
    })
  })

  test('saga yang berhenti tanpa kompensasi dibedakan dari yang kompensasinya gagal', () => {
    expect(toSagaRow(toReview(waiting, T1, 'skipped', 'x'), 'a').compensationStatus).toBe('none')
    expect(toSagaRow(toReview(waiting, T1, 'failed', 'x'), 'a').compensationStatus).toBe('failed')
  })
})

describe('baris rusak', () => {
  const valid = toSagaRow(running, 'saga-1')

  test.each([
    ['succeeded', 'running'],
    ['started', 'failed'],
    ['waiting', 'completed'],
  ] as const)('%s/%s ditolak dengan nama kolomnya', (stepStatus, compensationStatus) => {
    const row: SagaRow = { ...valid, stepStatus, compensationStatus }

    expect(() => fromSagaRow(row)).toThrow(/step_status\/compensation_status/)
  })
})
