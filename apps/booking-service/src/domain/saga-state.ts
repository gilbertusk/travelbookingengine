import {
  compensationPlan,
  nextDirectCompensation,
  outboxCompensations,
  type OutboxCompensation,
  type SagaStep,
} from './saga-definition.js'

/**
 * Keadaan saga satu pemesanan, dan perpindahannya — fungsi murni.
 *
 * Keadaan saga BUKAN keadaan pemesanan. Pemesanan menjawab "apa yang sudah
 * terjadi pada pemesanan ini" dan dilihat pengguna; saga menjawab "apa yang
 * sedang dikerjakan sistem untuknya, dan apa yang harus dibalik bila gagal".
 * Keduanya berubah dalam transaksi yang sama bila keduanya berubah — lihat
 * application/saga — tetapi saga juga berubah sendiri: niat menjalankan
 * langkah dicatat SEBELUM langkahnya berjalan, ketika pemesanan belum
 * berubah sama sekali.
 *
 * Tidak ada jam di sini. Setiap perpindahan menerima `at` dan durasi dari
 * pemanggil, seperti mesin keadaan pemesanan Step 16.
 */

interface SagaBase {
  readonly bookingId: string
  /**
   * Langkah terakhir yang dimasuki saga. Pada fase kompensasi dan akhir,
   * langkah tempat saga berhenti maju.
   */
  readonly step: SagaStep
  /** Percobaan langkah maju yang sekarang, atau percobaan kompensasi langsung. */
  readonly attempts: number
  readonly lastError: string | undefined
  /** Kunci optimistik: dua proses yang membaca versi yang sama tidak dapat sama-sama menang. */
  readonly version: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

export type SagaState =
  | (SagaBase & {
      readonly phase: 'running'
      /**
       * `started`: langkah langsung (Redis, HTTP) sedang dikerjakan, dicatat
       * SEBELUM dikerjakan. `waiting`: perintahnya sudah terkirim lewat outbox
       * dan saga menunggu jawaban.
       */
      readonly stepStatus: 'started' | 'waiting'
      /** Batas menunggu jawaban. Lewat berarti jawabannya dianggap tidak akan datang. */
      readonly deadlineAt: Date | undefined
      /** Sewa proses yang menjalankan langkah `started`. Lewat berarti prosesnya mati. */
      readonly leasedUntil: Date | undefined
    })
  | (SagaBase & {
      readonly phase: 'compensating'
      /** Langkah berikutnya yang kompensasi LANGSUNG-nya belum selesai. */
      readonly compensating: SagaStep | undefined
      readonly leasedUntil: Date | undefined
      /** Refund yang sudah diminta lewat outbox dan belum dikonfirmasi. */
      readonly refundDueBy: Date | undefined
    })
  | (SagaBase & { readonly phase: 'completed' })
  | (SagaBase & { readonly phase: 'compensated' })
  | (SagaBase & {
      readonly phase: 'review'
      /**
       * `skipped`: saga berhenti TANPA mengompensasi — status supplier tidak
       * dapat dipastikan, dan refund membabi buta adalah kerugian jenis lain
       * (US-05). `failed`: kompensasinya sendiri yang gagal atau terbukti
       * salah alamat.
       */
      readonly compensation: 'skipped' | 'failed'
    })

export type SagaPhase = SagaState['phase']

export const FINISHED_PHASES = [
  'completed',
  'compensated',
  'review',
] as const satisfies readonly SagaPhase[]

export function isSagaFinished(saga: SagaState): boolean {
  return FINISHED_PHASES.some((phase) => phase === saga.phase)
}

function after(at: Date, ms: number): Date {
  return new Date(at.getTime() + ms)
}

function base(saga: SagaState, at: Date, step: SagaStep = saga.step) {
  return {
    bookingId: saga.bookingId,
    step,
    attempts: saga.attempts,
    lastError: saga.lastError,
    version: saga.version + 1,
    createdAt: saga.createdAt,
    updatedAt: at,
  }
}

/**
 * Saga dimulai oleh permintaan hold: langkah pertama yang MENGUBAH sesuatu
 * adalah hold lokal, dan niatnya dicatat sebelum kursi diambil.
 */
export function beginSaga(bookingId: string, at: Date, leaseMs: number): SagaState {
  return {
    bookingId,
    phase: 'running',
    step: 'holdLocal',
    stepStatus: 'started',
    deadlineAt: undefined,
    leasedUntil: after(at, leaseMs),
    attempts: 1,
    lastError: undefined,
    version: 1,
    createdAt: at,
    updatedAt: at,
  }
}

/** Langkah yang dijalankan permintaan hold pengguna, sebelum ada uang. */
const HOLD_STEPS = ['holdLocal', 'holdSupplier'] as const satisfies readonly SagaStep[]

/**
 * Hold yang dicoba ulang pengguna setelah percobaan sebelumnya dikompensasi —
 * kamar habis, supplier lambat, harga berubah saat hold. Saga yang sama
 * dimulai lagi, dengan hitungan percobaannya.
 *
 * `undefined` untuk saga yang masih berjalan atau sudah melewati hold: dua
 * hold untuk satu pemesanan berarti dua unit tertahan di supplier.
 */
export function restartSaga(previous: SagaState, at: Date, leaseMs: number): SagaState | undefined {
  const abortedDuringHold =
    previous.phase === 'compensated' && HOLD_STEPS.some((step) => step === previous.step)
  if (!abortedDuringHold) return undefined

  return {
    ...base(previous, at, 'holdLocal'),
    phase: 'running',
    stepStatus: 'started',
    deadlineAt: undefined,
    leasedUntil: after(at, leaseMs),
    attempts: previous.attempts + 1,
    lastError: undefined,
  }
}

/** Langkah langsung berikutnya dimasuki; niatnya dicatat sebelum dikerjakan. */
export function enterStep(saga: SagaState, step: SagaStep, at: Date, leaseMs: number): SagaState {
  return {
    ...base(saga, at, step),
    phase: 'running',
    stepStatus: 'started',
    deadlineAt: undefined,
    leasedUntil: after(at, leaseMs),
  }
}

/** Perintahnya sudah di outbox; saga menunggu jawaban sampai `deadlineAt`. */
export function awaitReply(
  saga: SagaState,
  step: SagaStep,
  at: Date,
  deadlineAt: Date | undefined,
): SagaState {
  return {
    ...base(saga, at, step),
    phase: 'running',
    stepStatus: 'waiting',
    deadlineAt,
    leasedUntil: undefined,
  }
}

export function completeSaga(saga: SagaState, at: Date): SagaState {
  return { ...base(saga, at, 'issueVoucher'), phase: 'completed' }
}

export interface CompensationStart {
  /** Langkah terakhir yang efeknya harus dibalik. `undefined`: belum ada efek apa pun. */
  readonly through: SagaStep | undefined
  /** Langkah tempat saga berhenti maju. */
  readonly stoppedAt: SagaStep
  readonly at: Date
  readonly leaseMs: number
  /** Batas menunggu konfirmasi refund, bila rencana memuat refund. */
  readonly awaitRefundTimeoutMs: number
  readonly reason: string
}

export interface CompensationBegun {
  readonly saga: SagaState
  /** Dikirim SEKARANG, lewat outbox, dalam transaksi yang sama dengan `saga`. */
  readonly outbox: readonly OutboxCompensation[]
}

/**
 * Kompensasi dimulai: rencana disusun dari tabel, perintah outbox diminta
 * sekaligus, dan penunjuk diarahkan ke kompensasi langsung pertama.
 *
 * Urutannya mundur, sesuai rencana — refund diminta sebelum hold lokal
 * dilepas — tetapi refund tidak DITUNGGU sebelum hold dilepas: jawabannya
 * datang lewat Kafka, mungkin menit kemudian, dan kursi tidak perlu tertahan
 * selama itu (step doc 19: "kirim perintah payment.refund, lepaskan hold,
 * pindahkan ke FAILED lalu REFUNDED setelah refund berhasil").
 */
export function beginCompensation(saga: SagaState, start: CompensationStart): CompensationBegun {
  const plan = start.through === undefined ? [] : compensationPlan(start.through)
  const outbox = outboxCompensations(plan)
  const direct = nextDirectCompensation(plan)
  const refundDueBy = outbox.includes('refundPayment')
    ? after(start.at, start.awaitRefundTimeoutMs)
    : undefined
  const stopped = { ...saga, step: start.stoppedAt, lastError: start.reason }

  return {
    saga: settle(stopped, start.at, {
      compensating: direct?.name,
      leaseMs: start.leaseMs,
      refundDueBy,
    }),
    outbox,
  }
}

/**
 * Satu kompensasi langsung selesai; penunjuk mundur ke kompensasi langsung
 * berikutnya. Saga terkompensasi penuh bila tidak ada lagi yang tersisa DAN
 * tidak ada refund yang masih ditunggu.
 */
export function directCompensationDone(saga: SagaState, at: Date, leaseMs: number): SagaState {
  if (saga.phase !== 'compensating' || saga.compensating === undefined) return saga

  // Rencana dari penunjuk mundur, melompati penunjuknya sendiri.
  const plan = compensationPlan(saga.compensating)
  const next = nextDirectCompensation(plan, saga.compensating)

  return settle(saga, at, { compensating: next?.name, leaseMs, refundDueBy: saga.refundDueBy })
}

/** Refund yang diminta saga sudah dikonfirmasi payment-service. */
export function refundSettled(saga: SagaState, at: Date): SagaState {
  if (saga.phase !== 'compensating') return saga

  return settle(saga, at, { compensating: saga.compensating, leaseMs: 0, refundDueBy: undefined })
}

interface Pending {
  /** Kompensasi langsung berikutnya, bila masih ada. */
  readonly compensating: SagaStep | undefined
  readonly leaseMs: number
  /** Refund yang masih ditunggu, bila ada. */
  readonly refundDueBy: Date | undefined
}

function settle(saga: SagaState, at: Date, pending: Pending): SagaState {
  const next = { ...base(saga, at), attempts: 0 }
  const { compensating, leaseMs, refundDueBy } = pending

  if (compensating === undefined && refundDueBy === undefined) {
    return { ...next, phase: 'compensated' }
  }

  return {
    ...next,
    phase: 'compensating',
    compensating,
    leasedUntil: compensating === undefined ? undefined : after(at, leaseMs),
    refundDueBy,
  }
}

/**
 * Pemulihan mengambil alih kompensasi langsung yang sewanya sudah lewat:
 * sewa baru dicatat LEBIH DULU, dan hanya satu pemulih yang dapat
 * menyimpannya — kunci versi yang memutuskan. Pemulih yang kalah berhenti.
 */
export function renewLease(saga: SagaState, at: Date, leaseMs: number): SagaState {
  if (saga.phase !== 'compensating' || saga.compensating === undefined) return saga

  return {
    ...base(saga, at),
    phase: 'compensating',
    compensating: saga.compensating,
    leasedUntil: after(at, leaseMs),
    refundDueBy: saga.refundDueBy,
  }
}

export interface RetryPolicy {
  readonly maxAttempts: number
  readonly retryDelayMs: number
}

/**
 * Kompensasi langsung gagal. Dicoba lagi setelah jeda — sewanya diatur ke
 * saat itu, dan penyapu saga yang akan mengambilnya — sampai percobaan habis.
 * Setelah itu saga berhenti untuk ditinjau manusia. TIDAK diabaikan, dan tidak
 * dicoba selamanya.
 */
export function compensationAttemptFailed(
  saga: SagaState,
  at: Date,
  error: string,
  policy: RetryPolicy,
): SagaState {
  if (saga.phase !== 'compensating') return saga

  const attempts = saga.attempts + 1
  const next = { ...base(saga, at), attempts, lastError: error }

  if (attempts >= policy.maxAttempts) return { ...next, phase: 'review', compensation: 'failed' }

  return {
    ...next,
    phase: 'compensating',
    compensating: saga.compensating,
    leasedUntil: after(at, policy.retryDelayMs),
    refundDueBy: saga.refundDueBy,
  }
}

export function toReview(
  saga: SagaState,
  at: Date,
  compensation: 'skipped' | 'failed',
  reason: string,
): SagaState {
  return { ...base(saga, at), lastError: reason, phase: 'review', compensation }
}

/**
 * Pembayaran yang tidak dapat diterima pemesanan — tiba setelah hold
 * kedaluwarsa atau setelah pembatalan — dikembalikan, dan saga yang sudah
 * selesai membuka diri lagi untuk menunggu konfirmasi refund itu.
 *
 * `undefined` bila saga sedang menunggu refund LAIN atau sudah diserahkan ke
 * manusia: satu batas waktu tidak dapat menjaga dua refund, dan pemanggil
 * mencatatnya sebagai galat alih-alih berpura-pura menjaganya.
 */
export function awaitOrphanRefund(
  saga: SagaState,
  at: Date,
  refundDueBy: Date,
  reason: string,
): SagaState | undefined {
  if (saga.phase === 'compensated') {
    return {
      ...base(saga, at),
      lastError: reason,
      attempts: 0,
      phase: 'compensating',
      compensating: undefined,
      leasedUntil: undefined,
      refundDueBy,
    }
  }
  if (saga.phase === 'compensating' && saga.refundDueBy === undefined) {
    return {
      ...base(saga, at),
      lastError: reason,
      phase: 'compensating',
      compensating: saga.compensating,
      leasedUntil: saga.leasedUntil,
      refundDueBy,
    }
  }

  return undefined
}

/**
 * Saga untuk pemesanan yang tidak pernah punya saga — dibatalkan saat price
 * check — tetapi tetap menerima pembayaran.
 */
export function orphanRefundSaga(
  bookingId: string,
  at: Date,
  refundDueBy: Date,
  reason: string,
): SagaState {
  return {
    bookingId,
    phase: 'compensating',
    step: 'awaitPayment',
    compensating: undefined,
    leasedUntil: undefined,
    refundDueBy,
    attempts: 0,
    lastError: reason,
    version: 1,
    createdAt: at,
    updatedAt: at,
  }
}
