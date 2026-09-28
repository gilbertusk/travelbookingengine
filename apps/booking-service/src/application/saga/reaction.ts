import type { Booking } from '../../domain/booking.js'
import type { BookingCommand } from '../../domain/commands.js'
import type { BookingChange } from '../../domain/events.js'
import type { SagaState } from '../../domain/saga-state.js'
import { applyCommand } from '../../domain/transitions.js'
import type { BookingDeps, CommitOutcome, ConsumedMessage } from '../ports.js'

/**
 * Kerangka reaksi saga terhadap satu fakta dari luar — peristiwa Kafka dari
 * payment-service atau supplier-service.
 *
 * Setiap reaksi membaca pemesanan DAN sagannya, memutuskan, lalu menyimpan
 * keputusannya dalam satu unit kerja yang membawa catatan pesan terkonsumsi.
 * Dua jaminan datang dari bentuk ini, bukan dari disiplin tiap reaksi:
 *
 * - **Pesan yang sama dua kali tidak berefek dua kali.** Catatan terkonsumsi
 *   ditolak kunci primernya pada kali kedua, dan seluruh efeknya ikut batal.
 * - **Kalah balapan berarti memutuskan ulang, bukan menimpa.** Reaksi yang
 *   membaca keadaan yang lalu berubah — jawaban supplier yang tiba bersamaan
 *   dengan batas waktunya — membaca ulang dan memutuskan atas keadaan yang
 *   menang.
 */

export type Reaction = 'applied' | 'duplicate' | 'ignored' | 'unknown_booking'

export interface Fact {
  readonly eventId: string
  readonly eventType: string
  readonly bookingId: string
}

export interface Situation {
  readonly booking: Booking
  readonly saga: SagaState | undefined
  readonly consumed: ConsumedMessage
  readonly at: Date
}

export type Decision = CommitOutcome | 'ignored' | 'duplicate'

/**
 * Batas memutuskan ulang. Kecil dengan sengaja: tiga kekalahan berturut-turut
 * atas pemesanan yang sama berarti sesuatu yang lain sedang terjadi, dan
 * pesannya lebih baik dilempar kembali ke Kafka — dibaca lagi nanti — daripada
 * berputar di sini.
 */
const MAX_DECISIONS = 3

export async function react(
  deps: BookingDeps,
  fact: Fact,
  decide: (situation: Situation) => Promise<Decision>,
): Promise<Reaction> {
  const consumed = { eventId: fact.eventId, eventType: fact.eventType }

  for (let attempt = 1; attempt <= MAX_DECISIONS; attempt += 1) {
    const booking = await deps.bookings.findById(fact.bookingId)
    if (booking === undefined) {
      deps.logger.warn({ ...fact }, 'peristiwa untuk pemesanan yang tidak dikenal dilewati')
      return 'unknown_booking'
    }

    const saga = await deps.sagas.find(fact.bookingId)
    const decision = await decide({ booking, saga, consumed, at: deps.clock.now() })

    if (decision === 'committed') return 'applied'
    if (decision === 'already_consumed') return 'duplicate'
    if (decision !== 'stale') return decision
  }

  throw new Error(
    `${fact.eventType} untuk ${fact.bookingId} kalah balapan ${String(MAX_DECISIONS)} kali berturut-turut`,
  )
}

/**
 * Perintah domain yang MENURUT keadaan sekarang pasti sah. Penolakan berarti
 * pemanggilnya salah membaca tabel transisi — cacat program, dilempar ke batas
 * sistem, bukan dijawab sebagai hasil.
 */
export function mustApply(booking: Booking, command: BookingCommand): BookingChange {
  const result = applyCommand(booking, command)
  if (!result.ok) {
    throw new Error(`perintah ${command.type} ditolak untuk ${booking.id}: ${result.error.message}`)
  }

  return result.value
}

/** Saga pemesanan yang sudah melewati hold. Setiap pemesanan seperti itu punya saga. */
export function requireSaga(saga: SagaState | undefined, booking: Booking): SagaState {
  if (saga === undefined) {
    throw new Error(`pemesanan ${booking.status} ${booking.id} tidak punya saga`)
  }

  return saga
}

/**
 * Keadaan saga untuk unit kerja — hanya bila berubah. Menyimpan saga yang
 * tidak berubah dengan versi yang sama akan selalu kalah dari dirinya sendiri.
 */
export function sagaIfChanged(before: SagaState, after: SagaState): { saga?: SagaState } {
  return after === before ? {} : { saga: after }
}
