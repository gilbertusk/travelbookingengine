import { randomUUID } from 'node:crypto'
import { COMMAND_PAYLOADS, EVENT_PAYLOADS } from '@tbe/event-contracts'
import { currentTraceparent, getOrCreateCorrelationId } from '@tbe/shared-kernel'
import { toContractEvent, type ContractEvent } from '../application/contract-payloads.js'
import type { OutboundCommand } from '../application/ports.js'
import type { BookingEvent } from '../domain/events.js'
import type { OutboxWriteColumns } from './booking-db.js'
import { toJsonObject } from './booking-rows.js'

/**
 * Baris outbox, disusun di dalam transaksi bisnis.
 *
 * Amplop pesan DITETAPKAN di sini, bukan saat terbit:
 *
 * - `id` adalah eventId pesannya. Penerbit yang mati setelah mengirim dan
 *   sebelum menandai terbit mengirim ulang dengan eventId yang SAMA, dan
 *   consumer mengenali duplikatnya.
 * - `occurredAt` adalah waktu perubahan keadaan. payment-service memilih nilai
 *   tagihan terakhir menurut nilai itu — penerbit yang tertinggal tidak boleh
 *   mengubah urutannya.
 * - `correlationId` dan `traceparent` adalah milik permintaan yang menyebabkan
 *   perubahan. Diambil dari konteks yang sedang berjalan SEKARANG, karena saat
 *   penerbit berjalan, permintaannya sudah lama selesai.
 *
 * Payload divalidasi terhadap kontraknya SEBELUM ditulis. Pesan yang tidak
 * akan pernah lolos kontrak menggagalkan transaksinya — keadaan ikut batal —
 * alih-alih tertulis lalu menahan penerbit di belakangnya.
 */

interface Envelope {
  readonly bookingId: string
  readonly occurredAt: Date
  readonly createdAt: Date
  readonly causationId: string | undefined
}

function envelope(meta: Envelope) {
  return {
    id: randomUUID(),
    bookingId: meta.bookingId,
    correlationId: getOrCreateCorrelationId(),
    causationId: meta.causationId ?? null,
    traceparent: currentTraceparent() ?? null,
    occurredAt: meta.occurredAt,
    createdAt: meta.createdAt,
  }
}

/** Padanan Kafka sebuah peristiwa domain, atau `undefined` bila tidak punya. */
export function eventRow(
  event: BookingEvent,
  meta: Omit<Envelope, 'bookingId' | 'occurredAt'>,
): OutboxWriteColumns | undefined {
  const contract = toContractEvent(event)
  if (contract === undefined) return undefined

  return {
    ...envelope({ ...meta, bookingId: event.bookingId, occurredAt: event.occurredAt }),
    channel: 'kafka',
    messageType: contract.type,
    payload: validEventPayload(contract),
  }
}

export function commandRow(command: OutboundCommand, meta: Envelope): OutboxWriteColumns {
  const payload = COMMAND_PAYLOADS[command.type].parse(command.payload)

  return {
    ...envelope(meta),
    channel: 'rabbitmq',
    messageType: command.type,
    payload: toJsonObject(payload),
  }
}

function validEventPayload(contract: ContractEvent) {
  return toJsonObject(EVENT_PAYLOADS[contract.type].parse(contract.payload))
}
