import type { Logger } from '@tbe/shared-kernel'
import { ValidationError } from '@tbe/shared-kernel'
import type { BookingDb, BookingTx, OutboxRow } from './booking-db.js'

/**
 * Penerbit outbox (Step 19): membaca pesan yang belum terbit dan mengirimnya
 * ke Kafka atau RabbitMQ, MINIMAL SEKALI.
 *
 * Tiga keputusan, masing-masing dengan alternatif yang ditolak:
 *
 * 1. **Satu penerbit pada satu waktu, lewat kunci penasihat transaksi
 *    Postgres** (`pg_try_advisory_xact_lock`). Dengan beberapa instance
 *    booking-service, dua penerbit yang masing-masing mengambil setengah
 *    antrean — `FOR UPDATE SKIP LOCKED` — dapat menerbitkan peristiwa kedua
 *    sebuah pemesanan sebelum yang pertama. Kunci dilepas Postgres sendiri
 *    saat transaksi berakhir, termasuk saat prosesnya mati; kunci sesi atau
 *    tabel sewa buatan sendiri tidak.
 * 2. **Berhenti pada kegagalan sementara pertama**, bukan melompatinya. Pesan
 *    yang dilompati lalu terbit belakangan membalik urutan per pemesanan —
 *    `booking.failed` sebelum `booking.held`.
 * 3. **Pesan yang ditolak kontraknya disisihkan**, tidak ditunggu. Pesan itu
 *    tidak akan pernah lolos, dan menunggunya berarti seluruh outbox berhenti
 *    selamanya. Pesan sudah divalidasi saat ditulis (outbox-rows.ts), jadi
 *    penolakan di sini berarti kontraknya berubah di antara tulis dan terbit —
 *    dicatat tingkat error.
 *
 * Minimal sekali, bukan tepat sekali: penerbit yang mati SETELAH mengirim dan
 * sebelum commit menandai terbit akan mengirim ulang pesan yang sama — dengan
 * eventId yang sama. Consumer yang menyaringnya.
 */

/** Kunci penasihat penerbit outbox booking-service. Nilainya bebas, asal tetap. */
export const OUTBOX_LOCK_KEY = 1_900_019n

export interface OutboxMessage {
  readonly id: string
  readonly bookingId: string
  readonly channel: OutboxRow['channel']
  readonly messageType: string
  readonly payload: unknown
  readonly correlationId: string
  readonly causationId: string | undefined
  readonly traceparent: string | undefined
  readonly occurredAt: Date
}

/**
 * Pengirim ke broker. Melempar `ValidationError` bila kontrak menolak pesan —
 * pembeda antara "tidak akan pernah berhasil" dan "belum berhasil".
 */
export interface OutboxTransport {
  send(message: OutboxMessage): Promise<void>
}

export interface RelayReport {
  /** false: penerbit lain sedang memegang kunci; tidak ada yang dikerjakan. */
  readonly locked: boolean
  readonly published: number
  readonly rejected: number
  /** true: berhenti pada kegagalan sementara; sisanya menunggu putaran berikutnya. */
  readonly stalled: boolean
}

export interface RelayOptions {
  readonly batch: number
  readonly transactionTimeoutMs: number
  readonly now: () => Date
  readonly logger: Logger
}

export interface OutboxRelay {
  relayOnce(): Promise<RelayReport>
}

type Delivery = 'published' | 'rejected' | 'stalled'

interface Relay {
  readonly transport: OutboxTransport
  readonly options: RelayOptions
}

export function createOutboxRelay(
  db: BookingDb,
  transport: OutboxTransport,
  options: RelayOptions,
): OutboxRelay {
  const relay = { transport, options }

  return {
    relayOnce: async () =>
      await db.$transaction(
        async (tx) => {
          if (!(await acquired(tx))) {
            return { locked: false, published: 0, rejected: 0, stalled: false }
          }
          return await drain(relay, tx)
        },
        { timeout: options.transactionTimeoutMs },
      ),
  }
}

async function drain(relay: Relay, tx: BookingTx): Promise<RelayReport> {
  const rows = await tx.outboxMessage.findMany({
    where: { publishedAt: null, rejectedAt: null },
    orderBy: { sequence: 'asc' },
    take: relay.options.batch,
  })
  const counts = { published: 0, rejected: 0 }

  for (const row of rows) {
    const outcome = await deliver(relay, tx, row)
    if (outcome === 'stalled') return { locked: true, ...counts, stalled: true }
    counts[outcome] += 1
  }

  return { locked: true, ...counts, stalled: false }
}

async function deliver(relay: Relay, tx: BookingTx, row: OutboxRow): Promise<Delivery> {
  const { options } = relay
  try {
    await relay.transport.send(messageOf(row))
    await tx.outboxMessage.update({ where: { id: row.id }, data: { publishedAt: options.now() } })
    return 'published'
  } catch (error) {
    const lastError = describe(error)
    const attempts = row.attempts + 1

    if (error instanceof ValidationError) {
      options.logger.error(
        { outboxId: row.id, bookingId: row.bookingId, type: row.messageType, lastError },
        'pesan outbox ditolak kontraknya dan disisihkan, butuh penanganan manusia',
      )
      const data = { attempts, lastError, rejectedAt: options.now() }
      await tx.outboxMessage.update({ where: { id: row.id }, data })
      return 'rejected'
    }

    options.logger.warn(
      { outboxId: row.id, type: row.messageType, attempts, lastError },
      'penerbitan outbox gagal, dicoba lagi pada putaran berikutnya',
    )
    await tx.outboxMessage.update({ where: { id: row.id }, data: { attempts, lastError } })
    return 'stalled'
  }
}

async function acquired(tx: BookingTx): Promise<boolean> {
  const rows = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(${OUTBOX_LOCK_KEY}) AS locked`

  return Array.isArray(rows) && rows.some((row: unknown) => isLocked(row))
}

function isLocked(row: unknown): boolean {
  return typeof row === 'object' && row !== null && 'locked' in row && row.locked === true
}

function messageOf(row: OutboxRow): OutboxMessage {
  return {
    id: row.id,
    bookingId: row.bookingId,
    channel: row.channel,
    messageType: row.messageType,
    payload: row.payload,
    correlationId: row.correlationId,
    causationId: row.causationId ?? undefined,
    traceparent: row.traceparent ?? undefined,
    occurredAt: row.occurredAt,
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
