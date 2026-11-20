import type { Money } from '@tbe/money'
import type { Logger } from '@tbe/shared-kernel'
import type { Booking, BookingIn, SupplierCode } from '../domain/booking.js'
import {
  compare,
  type LedgerAnswer,
  type MismatchKind,
  type ReconciledStatus,
  type Verdict,
} from '../domain/reconciliation.js'
import type { BookingRepository, Clock } from './ports.js'
import { supplierIdempotencyKey } from './saga/commands.js'
import { mustApply } from './saga/reaction.js'

/**
 * Rekonsiliasi dengan supplier (Step 28, FR-33, keputusan Q4).
 *
 * Jaring pengaman TERAKHIR. Saga, pemulih, dan penyapu menjaga pemesanan
 * berakhir di keadaan final; rekonsiliasi memeriksa apakah keadaan final itu
 * BENAR menurut satu-satunya pihak yang memegang kamarnya.
 *
 * Satu-satunya akibat ketidaksesuaian: pemesanan dipindahkan ke NEEDS_REVIEW
 * dengan alasannya, dan temuannya dicatat. Tidak ada konfirmasi ulang, refund,
 * atau pembatalan otomatis. Supplier yang sedang bermasalah — basis data yang
 * dipulihkan dari cadangan semalam, API pencarian yang mengembalikan 404 untuk
 * semuanya — akan membuat ratusan pemesanan sah tampak "hilang" dalam satu
 * putaran; perbaikan otomatis atas putaran itu adalah ratusan refund untuk
 * kamar yang sebenarnya ada. Peninjauan yang berlebihan dapat dibereskan
 * manusia; uang yang sudah keluar tidak.
 *
 * Supplier yang tidak dapat ditanya BUKAN ketidaksesuaian. Ia dicatat sebagai
 * `unverified`, tidak ditandai, dan diperiksa lagi putaran berikutnya.
 */

export interface SupplierLedger {
  lookup(
    query:
      | { readonly supplier: SupplierCode; readonly bookingReference: string }
      | { readonly supplier: SupplierCode; readonly idempotencyKey: string },
  ): Promise<LedgerAnswer>
}

/** Pemesanan yang diperiksa satu putaran. */
export interface CandidateWindow {
  /** CONFIRMED yang menginapnya belum selesai: checkOut pada atau sesudah hari ini (UTC). */
  readonly today: Date
  /** REFUNDED dan CANCELLED yang berubah sejak saat ini. */
  readonly since: Date
  /**
   * Tidak ada yang berubah sesudah saat ini yang diperiksa. Pemesanan yang
   * baru saja terkonfirmasi atau direfund mungkin belum terlihat di catatan
   * supplier — terutama yang diadopsi setelah timeout — dan memeriksanya
   * menghasilkan ketidaksesuaian yang hilang sendiri sepuluh detik kemudian.
   */
  readonly until: Date
}

export interface ReconciliationSource {
  candidates(window: CandidateWindow, limit: number): Promise<readonly Booking[]>
  /** Harga bersih supplier saat hold, dari peristiwa BookingHeld. */
  supplierTotalOf(bookingId: string): Promise<Money | undefined>
}

export interface RunRequest {
  /** eventId perintah `reconciliation.run`. */
  readonly id: string
  readonly day: string
  readonly supplier?: SupplierCode | undefined
}

/**
 * - `started`: putaran baru.
 * - `resumed`: putaran ini pernah dimulai dan tidak selesai — proses mati,
 *   atau basis data hilang di tengahnya — lalu perintahnya dikirim ulang.
 *   Seluruh kandidat diperiksa lagi; yang sudah ditandai tidak lagi menjadi
 *   kandidat, dan temuan unik per (putaran, pemesanan).
 * - `finished`: sudah selesai. Instance lain yang menerima perintah slot yang
 *   sama, atau pengiriman ulang RabbitMQ setelah ack yang hilang.
 */
export type RunStart = 'started' | 'resumed' | 'finished'

export type FindingKind = MismatchKind | 'unverified'

export interface Finding {
  readonly runId: string
  readonly bookingId: string
  readonly supplier: SupplierCode
  readonly localStatus: ReconciledStatus
  readonly kind: FindingKind
  readonly detail: string
  readonly flagged: boolean
  readonly recordedAt: Date
}

export interface RunTotals {
  readonly checked: number
  readonly matched: number
  readonly mismatched: number
  readonly unverified: number
  readonly flagged: number
}

export interface ReconciliationStore {
  begin(request: RunRequest, at: Date): Promise<RunStart>
  record(finding: Finding): Promise<void>
  finish(runId: string, totals: RunTotals, at: Date): Promise<void>
}

export interface ReconcilePolicy {
  /** Seberapa jauh ke belakang REFUNDED dan CANCELLED diperiksa. */
  readonly lookbackMs: number
  /** Lihat [CandidateWindow.until]. */
  readonly graceMs: number
  /** Batas pemesanan per putaran. Sisanya diperiksa putaran berikutnya. */
  readonly maxBookings: number
}

export interface ReconcileDeps {
  readonly source: ReconciliationSource
  readonly ledger: SupplierLedger
  readonly runs: ReconciliationStore
  readonly bookings: BookingRepository
  readonly clock: Clock
  readonly logger: Logger
  readonly policy: ReconcilePolicy
}

export type ReconcileOutcome =
  { readonly kind: 'already_finished' } | { readonly kind: 'finished'; readonly totals: RunTotals }

/** CANCELLED yang dibayar: dibatalkan pengguna setelah terkonfirmasi (Step 25). */
type PaidCancelled = Extract<BookingIn<'CANCELLED'>, { readonly paymentId: string }>
type Reconciled = BookingIn<'CONFIRMED' | 'REFUNDED'> | PaidCancelled

const DAY_MS = 24 * 60 * 60 * 1_000

export async function reconcile(
  deps: ReconcileDeps,
  request: RunRequest,
): Promise<ReconcileOutcome> {
  const startedAt = deps.clock.now()
  if ((await deps.runs.begin(request, startedAt)) === 'finished')
    return { kind: 'already_finished' }

  const candidates = await deps.source.candidates(
    windowAt(startedAt, deps.policy),
    deps.policy.maxBookings,
  )
  const totals = { checked: 0, matched: 0, mismatched: 0, unverified: 0, flagged: 0 }

  // Berurutan: satu pertanyaan ke supplier pada satu waktu. Rekonsiliasi tidak
  // terburu-buru, dan supplier yang sama melayani pencarian pengguna —
  // lonjakan dari jaring pengaman tidak boleh menghabiskan kuota mereka.
  for (const booking of candidates.filter(isReconciled)) {
    if (request.supplier !== undefined && booking.supplier !== request.supplier) continue
    totals.checked += 1
    const verdict = await check(deps, booking)

    if (verdict.kind === 'match') {
      totals.matched += 1
      continue
    }

    const flagged = verdict.kind === 'mismatch' && (await flag(deps, booking, verdict.reason))
    totals[verdict.kind === 'mismatch' ? 'mismatched' : 'unverified'] += 1
    if (flagged) totals.flagged += 1

    await deps.runs.record({
      runId: request.id,
      bookingId: booking.id,
      supplier: booking.supplier,
      localStatus: booking.status,
      kind: verdict.kind === 'mismatch' ? verdict.mismatch : 'unverified',
      detail: verdict.kind === 'mismatch' ? verdict.reason : 'supplier tidak dapat ditanya',
      flagged,
      recordedAt: deps.clock.now(),
    })
  }

  await deps.runs.finish(request.id, totals, deps.clock.now())
  // Tingkat error bila ada yang ditandai: pemesanan sungguhan di depan manusia.
  const level = totals.flagged > 0 ? 'error' : 'info'
  deps.logger[level]({ runId: request.id, ...totals }, 'putaran rekonsiliasi selesai')

  return { kind: 'finished', totals }
}

export function windowAt(now: Date, policy: ReconcilePolicy): CandidateWindow {
  return {
    today: new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS),
    since: new Date(now.getTime() - policy.lookbackMs),
    until: new Date(now.getTime() - policy.graceMs),
  }
}

/**
 * Kandidat dipilih kueri dengan keadaan ini, jadi saringan ini tidak menolak
 * apa pun pada jalan yang benar. Ia ada karena aturan "hanya yang pernah
 * dibayar": CANCELLED tanpa pembayaran yang lolos dari kueri akan ditolak
 * domain saat ditandai, dan putaran berhenti di tengah. Dilewati di sini.
 */
function isReconciled(booking: Booking): booking is Reconciled {
  return (
    booking.status === 'CONFIRMED' ||
    booking.status === 'REFUNDED' ||
    (booking.status === 'CANCELLED' && booking.paymentId !== undefined)
  )
}

async function check(deps: ReconcileDeps, booking: Reconciled): Promise<Verdict> {
  const handle = handleOf(booking)
  const answer = await deps.ledger.lookup(handle.query)
  // Harga hold hanya berarti untuk CONFIRMED yang ditemukan. Dibaca hanya
  // saat itu: satu kueri jejak per pemesanan terkonfirmasi, bukan per kandidat.
  const supplierTotal =
    booking.status === 'CONFIRMED' && answer.kind === 'found'
      ? await deps.source.supplierTotalOf(booking.id)
      : undefined

  return compare(
    {
      status: booking.status,
      supplier: booking.supplier,
      handle: handle.label,
      stay: booking.stay,
      supplierTotal,
    },
    answer,
  )
}

/**
 * Pegangan untuk bertanya. Booking reference bila ada — itulah bukti
 * pemesanan yang sah. REFUNDED tidak pernah menerimanya: konfirmasinya
 * dianggap gagal. Untuk itu satu-satunya pegangan adalah idempotency key yang
 * dikirim saat `book`, yang sama dengan yang dipakai pemulihan Step 11.
 */
function handleOf(booking: Reconciled) {
  if (booking.status === 'REFUNDED') {
    const key = supplierIdempotencyKey(booking.id)
    return { query: { supplier: booking.supplier, idempotencyKey: key }, label: `kunci ${key}` }
  }

  return {
    query: { supplier: booking.supplier, bookingReference: booking.supplierRef },
    label: booking.supplierRef,
  }
}

/**
 * `false` bila pemesanan bergerak sejak dibaca — pengguna meminta pembatalan
 * tepat saat putaran berjalan. Temuannya tetap dicatat, tidak ditandai;
 * putaran berikutnya memeriksa keadaan barunya.
 */
async function flag(deps: ReconcileDeps, booking: Reconciled, reason: string): Promise<boolean> {
  const change = mustApply(booking, { type: 'flagMismatch', at: deps.clock.now(), reason })
  const outcome = await deps.bookings.save(change)
  if (outcome.kind !== 'saved') return false

  deps.logger.error({ bookingId: booking.id, from: booking.status }, reason)
  return true
}
