import type { Money } from '@tbe/money'
import type { Booking } from '../../domain/booking.js'
import type { RefundQuote } from '../../domain/refund-schedule.js'
import { loadOwned } from '../persist.js'
import type { BookingDeps } from '../ports.js'
import { supplierCancel } from '../saga/commands.js'
import { mustApply } from '../saga/reaction.js'
import {
  assessCancellation,
  isCancellationUnderway,
  type CancellationAssessment,
  type NotCancellableReason,
} from './assess.js'

/**
 * Pratinjau dan permintaan pembatalan oleh pengguna (Step 25, FR-27).
 */

export type PreviewResult = { readonly kind: 'not_found' } | CancellationAssessment

/**
 * Berapa yang kembali bila pengguna membatalkan sekarang — tanpa mengubah
 * apa pun. Pengguna harus tahu nilainya SEBELUM menekan tombol; permintaan
 * pembatalan menuntut nilai ini kembali sebagai persetujuannya.
 */
export async function previewCancellation(
  deps: BookingDeps,
  request: { readonly userId: string; readonly bookingId: string },
): Promise<PreviewResult> {
  const booking = await loadOwned(deps, request.userId, request.bookingId)
  if (booking === undefined) return { kind: 'not_found' }

  return await assessCancellation(deps, booking, deps.clock.now())
}

export interface CancellationRequest {
  readonly userId: string
  readonly bookingId: string
  /**
   * Nilai pengembalian yang DILIHAT pengguna di pratinjau. Bila jenjangnya
   * berganti di antara pratinjau dan tombol ditekan — tenggat 24 jam lewat
   * saat pengguna ragu — pembatalan tidak dijalankan dengan nilai yang tidak
   * pernah ia setujui.
   */
  readonly expectedRefund: Money
}

export type CancellationResult =
  /** Diterima: baru saja, atau sudah sejak permintaan sebelumnya. */
  | { readonly kind: 'accepted'; readonly booking: Booking }
  | { readonly kind: 'quote_changed'; readonly quote: RefundQuote }
  | { readonly kind: 'not_cancellable'; readonly reason: NotCancellableReason }
  | { readonly kind: 'retry_later' }
  | { readonly kind: 'not_found' }

/**
 * Batas memutuskan ulang setelah kalah balapan. Lawan yang paling mungkin
 * adalah permintaan pembatalan yang sama dari tab lain — sesudahnya, pemesanan
 * sudah CANCELLING dan jawabannya `accepted`.
 */
const MAX_DECISIONS = 3

/**
 * Pembatalan dimulai: CONFIRMED → CANCELLING dan `supplier.cancel` ke outbox,
 * dalam SATU transaksi. Tidak ada refund di sini — refund baru dikirim setelah
 * supplier memastikan kamarnya lepas (lihat on-replies.ts).
 *
 * Permintaan berulang tidak menghasilkan pembatalan kedua. Kunci versi
 * pemesanan memastikan hanya satu yang memindahkannya ke CANCELLING; yang lain
 * membaca ulang dan dijawab `accepted` dengan keadaan yang menang.
 */
export async function requestCancellation(
  deps: BookingDeps,
  request: CancellationRequest,
): Promise<CancellationResult> {
  for (let attempt = 1; attempt <= MAX_DECISIONS; attempt += 1) {
    const booking = await loadOwned(deps, request.userId, request.bookingId)
    if (booking === undefined) return { kind: 'not_found' }
    if (isCancellationUnderway(booking)) return { kind: 'accepted', booking }

    const decision = await decide(deps, booking, request.expectedRefund)
    if (decision !== 'stale') return decision
  }

  throw new Error(`pembatalan ${request.bookingId} kalah balapan ${String(MAX_DECISIONS)} kali`)
}

async function decide(
  deps: BookingDeps,
  booking: Booking,
  expectedRefund: Money,
): Promise<CancellationResult | 'stale'> {
  const at = deps.clock.now()
  const assessment = await assessCancellation(deps, booking, at)
  if (assessment.kind !== 'quoted') return assessment

  const { quote } = assessment
  if (!isSameMoney(quote.refund, expectedRefund)) return { kind: 'quote_changed', quote }

  const confirmed = assessment.booking
  // Nilai pengembalian datang dari jadwal atas harga yang sama, jadi tidak
  // dapat melebihi pembayaran: penolakan di sini cacat program, dan dilempar.
  const change = mustApply(confirmed, {
    type: 'requestCancellation',
    at,
    quote: {
      refund: quote.refund,
      percent: quote.percent,
      until: quote.until,
      timeZone: quote.timeZone,
      checkInStartsAt: quote.checkInStartsAt,
    },
    replyBy: new Date(at.getTime() + deps.sagaPolicy.confirmTimeoutMs),
  })

  const outcome = await deps.sagas.commit({
    bookingId: confirmed.id,
    at,
    change,
    commands: [supplierCancel(confirmed, confirmed.supplierRef)],
  })
  if (outcome !== 'committed') return 'stale'

  deps.logger.info(
    { bookingId: confirmed.id, percent: quote.percent, refundMinor: quote.refund.amountMinor },
    'pembatalan diminta pengguna, menunggu supplier',
  )

  return { kind: 'accepted', booking: change.booking }
}

function isSameMoney(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amountMinor === b.amountMinor
}
