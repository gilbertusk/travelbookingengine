import type { SagaState } from '../domain/saga-state.js'
import type { SagaRow, SagaUpdateColumns } from './booking-db.js'

/**
 * Pemetaan keadaan saga ke baris saga_states, dan sebaliknya.
 *
 * Kolom step doc — `step_status` dan `compensation_status` — bukan penyimpanan
 * fase apa adanya: fase saga DITURUNKAN dari pasangan keduanya. Pasangan yang
 * tidak dikenal adalah baris rusak, dan dilempar dengan nama kolomnya, bukan
 * ditebak menjadi fase terdekat — tebakan di sini berarti pemulihan
 * menjalankan kompensasi untuk saga yang sudah selesai.
 *
 *   step_status  compensation_status  fase
 *   started      none                 running (langkah langsung berjalan)
 *   waiting      none                 running (menunggu jawaban)
 *   succeeded    none                 completed
 *   failed       running              compensating
 *   failed       completed            compensated
 *   failed       none                 review — berhenti TANPA kompensasi (US-05)
 *   failed       failed               review — kompensasinya yang gagal
 */

export class CorruptSagaRowError extends Error {
  constructor(bookingId: string, detail: string) {
    super(`baris saga_states untuk ${bookingId} rusak: ${detail}`)
  }
}

export function toSagaColumns(saga: SagaState): SagaUpdateColumns {
  const common = {
    currentStep: saga.step,
    attempts: saga.attempts,
    lastError: saga.lastError ?? null,
    version: saga.version,
    updatedAt: saga.updatedAt,
  }

  switch (saga.phase) {
    case 'running':
      return {
        ...common,
        stepStatus: saga.stepStatus,
        compensationStatus: 'none',
        compensatingStep: null,
        deadlineAt: saga.deadlineAt ?? null,
        leasedUntil: saga.leasedUntil ?? null,
      }
    case 'compensating':
      return {
        ...common,
        stepStatus: 'failed',
        compensationStatus: 'running',
        compensatingStep: saga.compensating ?? null,
        // Satu kolom batas waktu untuk dua penantian yang tidak pernah
        // bersamaan: jawaban supplier (fase maju) dan konfirmasi refund.
        deadlineAt: saga.refundDueBy ?? null,
        leasedUntil: saga.leasedUntil ?? null,
      }
    case 'completed':
      return { ...common, ...idle(), stepStatus: 'succeeded', compensationStatus: 'none' }
    case 'compensated':
      return { ...common, ...idle(), stepStatus: 'failed', compensationStatus: 'completed' }
    case 'review':
      return {
        ...common,
        ...idle(),
        stepStatus: 'failed',
        compensationStatus: saga.compensation === 'skipped' ? 'none' : 'failed',
      }
  }
}

function idle() {
  return { compensatingStep: null, deadlineAt: null, leasedUntil: null }
}

export function toSagaRow(saga: SagaState, id: string): SagaRow {
  return { id, bookingId: saga.bookingId, createdAt: saga.createdAt, ...toSagaColumns(saga) }
}

export function fromSagaRow(row: SagaRow): SagaState {
  const base = {
    bookingId: row.bookingId,
    step: row.currentStep,
    attempts: row.attempts,
    lastError: row.lastError ?? undefined,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
  const pair = `${row.stepStatus}/${row.compensationStatus}`

  switch (pair) {
    case 'started/none':
    case 'waiting/none':
      return {
        ...base,
        phase: 'running',
        stepStatus: row.stepStatus === 'started' ? 'started' : 'waiting',
        deadlineAt: row.deadlineAt ?? undefined,
        leasedUntil: row.leasedUntil ?? undefined,
      }
    case 'failed/running':
      return {
        ...base,
        phase: 'compensating',
        compensating: row.compensatingStep ?? undefined,
        leasedUntil: row.leasedUntil ?? undefined,
        refundDueBy: row.deadlineAt ?? undefined,
      }
    case 'succeeded/none':
      return { ...base, phase: 'completed' }
    case 'failed/completed':
      return { ...base, phase: 'compensated' }
    case 'failed/none':
      return { ...base, phase: 'review', compensation: 'skipped' }
    case 'failed/failed':
      return { ...base, phase: 'review', compensation: 'failed' }
    default:
      throw new CorruptSagaRowError(row.bookingId, `step_status/compensation_status ${pair}`)
  }
}
