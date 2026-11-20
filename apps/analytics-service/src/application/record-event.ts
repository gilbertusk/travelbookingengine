import { incrementsFor, type Occurrence } from '../domain/counters.js'
import { needsSupplier, type AnalyticsFact } from '../domain/facts.js'
import type { AnalyticsDeps, RecordOutcome } from './ports.js'

/**
 * Mencatat satu peristiwa ke agregat (Step 27).
 *
 * Pembacaan supplier untuk fakta yang tidak menyebutnya terjadi di LUAR
 * transaksi pencatatan. Aman karena urutannya dijamin Kafka, bukan oleh kunci:
 * booking.created, booking.price_changed, dan booking.failed berada di topik
 * yang sama dan berkunci bookingId (event-contracts/topics.ts), jadi tiba di
 * partisi yang sama, berurutan, dan diproses satu per satu.
 */

export interface IncomingFact {
  readonly eventId: string
  readonly occurrence: Occurrence
  readonly fact: AnalyticsFact
}

export async function recordEvent(
  deps: AnalyticsDeps,
  input: IncomingFact,
): Promise<RecordOutcome> {
  const { fact } = input
  const supplier = needsSupplier(fact) ? await deps.store.supplierOf(fact.bookingId) : undefined

  return await deps.store.record(
    {
      eventId: input.eventId,
      eventType: input.occurrence.eventType,
      ...(fact.kind === 'booking_created'
        ? { bookingSupplier: { bookingId: fact.bookingId, supplier: fact.supplier } }
        : {}),
      increments: incrementsFor(fact, input.occurrence, supplier),
    },
    deps.clock.now(),
  )
}
