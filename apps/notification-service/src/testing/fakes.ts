import { createLogger } from '@tbe/shared-kernel'
import { VOUCHER_NOT_READY } from '../domain/delivery.js'
import type {
  BookingDirectory,
  DeliveryMetrics,
  DeliveryOutcome,
  EmailSender,
  NotificationDeps,
  NotificationRepository,
  OutgoingEmail,
  RequestOutcome,
  SendResult,
  Settlement,
  SnapshotLookup,
  VoucherDocuments,
} from '../application/ports.js'
import type { BookingSnapshot } from '../domain/booking-snapshot.js'
import type {
  ClaimedNotification,
  NotificationRequest,
  NotificationStatus,
  NotificationType,
} from '../domain/notification.js'

/**
 * Palsuan port notification-service.
 *
 * Repository palsuan MENIRU batasan UNIK dedupe_key dan sewa baris — baris
 * kedua dengan kunci yang sama ditolak, baris yang sedang disewa tidak diambil
 * lagi — alih-alih hanya mencatat panggilan. Uji deduplikasi bertumpu pada
 * perilaku itu; uji integrasi membuktikan Postgres berperilaku sama.
 */

export const USER = '7b9e2d14-1f3a-4e5c-8d6b-2a1c0f9e8d7c'
export const BOOKING_ID = '018f2a1c-0000-7000-8000-00000000b001'
export const START = new Date('2026-10-08T10:00:00.000Z')
export const VOUCHER_PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])

export function snapshot(overrides: Partial<BookingSnapshot> = {}): BookingSnapshot {
  return {
    bookingId: BOOKING_ID,
    userId: USER,
    status: 'CONFIRMED',
    supplierRef: 'SKY-BK-7F3A21',
    checkIn: '2026-11-10',
    checkOut: '2026-11-12',
    guestCount: 2,
    leadGuest: { fullName: 'Sari Wulandari', email: 'sari@example.com' },
    roomTypeName: 'Deluxe King',
    total: { amountMinor: 2_442_000, currency: 'IDR' },
    ...overrides,
  }
}

export interface Row {
  readonly id: string
  readonly request: NotificationRequest
  readonly status: NotificationStatus
  readonly userId: string | null
  readonly attempts: number
  readonly nextAttemptAt: Date
  readonly leaseUntil: Date | null
  readonly recipientKey: string | null
  readonly lastError: string | null
  readonly sentAt: Date | null
}

export interface FakeRepository extends NotificationRepository {
  readonly rows: Row[]
  failNext: boolean
}

export function fakeRepository(): FakeRepository {
  const rows: Row[] = []
  const replace = (id: string, changes: Partial<Row>): void => {
    replaceRow(rows, id, changes)
  }

  const fake: FakeRepository = {
    rows,
    failNext: false,
    async request(request, now): Promise<RequestOutcome> {
      if (fake.failNext) {
        fake.failNext = false
        throw new Error('Postgres tidak menjawab')
      }
      const existing = rows.find((row) => row.request.dedupeKey === request.dedupeKey)
      if (existing !== undefined) {
        wakeVoucherWaiter(existing, now, replace)
        return await Promise.resolve({ kind: 'duplicate' })
      }
      const id = `n-${String(rows.length + 1)}`
      rows.push(newRow(id, request, now))
      return { kind: 'created', id }
    },

    async claimNext(now, leaseMs) {
      const [due] = rows
        .filter((row) => isDue(row, now))
        .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
      if (due === undefined) return undefined
      const leaseUntil = new Date(now.getTime() + leaseMs)
      const attempts = due.status === 'SENDING' ? due.attempts + 1 : due.attempts
      replace(due.id, { status: 'SENDING', leaseUntil, attempts })
      return await Promise.resolve(toClaimed({ ...due, attempts, leaseUntil }))
    },

    async settle(claimed, settlement, now) {
      const row = rows.find((candidate) => candidate.id === claimed.id)
      if (row?.status !== 'SENDING' || row.leaseUntil?.getTime() !== claimed.leaseUntil.getTime()) {
        return false
      }
      replace(claimed.id, { leaseUntil: null, ...changesFor(settlement, now) })
      return await Promise.resolve(true)
    },

    async sentToRecipientSince(key, since) {
      return await Promise.resolve(
        rows.filter((row) => row.recipientKey === key && row.sentAt !== null && row.sentAt >= since)
          .length,
      )
    },
  }
  return fake
}

/** Setiap perubahan MENGGANTI baris, tidak mengubahnya di tempat. */
function replaceRow(rows: Row[], id: string, changes: Partial<Row>): void {
  const index = rows.findIndex((row) => row.id === id)
  const row = rows[index]
  if (row === undefined) throw new Error(`baris ${id} tidak ada`)
  rows.splice(index, 1, { ...row, ...changes })
}

function newRow(id: string, request: NotificationRequest, now: Date): Row {
  return {
    id,
    request,
    status: 'PENDING',
    userId: request.userId,
    attempts: 0,
    nextAttemptAt: now,
    leaseUntil: null,
    recipientKey: null,
    lastError: null,
    sentAt: null,
  }
}

function isDue(row: Row, now: Date): boolean {
  if (row.status === 'PENDING') return row.nextAttemptAt <= now
  return row.status === 'SENDING' && row.leaseUntil !== null && row.leaseUntil < now
}

function wakeVoucherWaiter(
  row: Row,
  now: Date,
  replace: (id: string, changes: Partial<Row>) => void,
): void {
  if (row.lastError !== VOUCHER_NOT_READY) return
  if (row.status === 'PENDING' && row.nextAttemptAt > now) replace(row.id, { nextAttemptAt: now })
  if (row.status === 'DEAD') replace(row.id, { status: 'PENDING', attempts: 0, nextAttemptAt: now })
}

function toClaimed(row: Row & { readonly leaseUntil: Date }): ClaimedNotification {
  return {
    id: row.id,
    type: row.request.context.type,
    leaseUntil: row.leaseUntil,
    bookingId: row.request.bookingId,
    userId: row.userId,
    dedupeKey: row.request.dedupeKey,
    attempts: row.attempts,
    correlationId: row.request.correlationId,
    context: row.request.context,
  }
}

function changesFor(settlement: Settlement, now: Date): Partial<Row> {
  switch (settlement.kind) {
    case 'sent':
      return {
        status: 'SENT',
        sentAt: settlement.at,
        recipientKey: settlement.recipientKey,
        userId: settlement.userId,
      }
    case 'failed':
      return {
        status: 'FAILED',
        lastError: settlement.reason,
        recipientKey: settlement.recipientKey,
      }
    case 'skipped':
      return { status: 'SKIPPED', lastError: settlement.reason }
    case 'retry':
      return {
        status: 'PENDING',
        attempts: settlement.attempts,
        nextAttemptAt: settlement.nextAttemptAt,
        lastError: settlement.reason,
      }
    case 'dead':
      return {
        status: 'DEAD',
        attempts: settlement.attempts,
        lastError: settlement.reason,
        nextAttemptAt: now,
      }
    case 'deferred':
      return {
        status: 'PENDING',
        nextAttemptAt: settlement.until,
        recipientKey: settlement.recipientKey,
        lastError: 'rate_limited',
      }
  }
}

export interface FakeBookings extends BookingDirectory {
  readonly snapshots: Map<string, BookingSnapshot>
  failing: boolean
  readonly calls: string[]
}

export function fakeBookings(snapshots: readonly BookingSnapshot[] = [snapshot()]): FakeBookings {
  const map = new Map(snapshots.map((item) => [item.bookingId, item]))
  const fake: FakeBookings = {
    snapshots: map,
    failing: false,
    calls: [],
    async notificationSource(bookingId): Promise<SnapshotLookup> {
      fake.calls.push(bookingId)
      if (fake.failing) throw new Error('booking-service tidak menjawab')
      const booking = map.get(bookingId)
      return await Promise.resolve(
        booking === undefined ? { kind: 'not_found' } : { kind: 'found', booking },
      )
    },
  }
  return fake
}

export interface FakeVouchers extends VoucherDocuments {
  readonly documents: Map<string, Uint8Array>
}

export function fakeVouchers(ready = true): FakeVouchers {
  const documents = new Map<string, Uint8Array>(ready ? [[BOOKING_ID, VOUCHER_PDF]] : [])
  return {
    documents,
    async document(bookingId) {
      return await Promise.resolve(documents.get(bookingId))
    },
  }
}

export interface FakeSender extends EmailSender {
  readonly sent: OutgoingEmail[]
  /** Jawaban berikutnya; kosong berarti terkirim. */
  readonly script: SendResult[]
  /** Dilempar alih-alih menjawab, mis. galat tak dikenal dari pustaka. */
  throwing: boolean
}

export function fakeSender(): FakeSender {
  const fake: FakeSender = {
    sent: [],
    script: [],
    throwing: false,
    async send(email) {
      if (fake.throwing) throw new Error('soket SMTP tertutup')
      const result = fake.script.shift() ?? { kind: 'sent' }
      if (result.kind === 'sent') fake.sent.push(email)
      return await Promise.resolve(result)
    },
  }
  return fake
}

export interface FakeMetrics extends DeliveryMetrics {
  readonly recorded: { type: NotificationType; outcome: DeliveryOutcome }[]
}

export function fakeMetrics(): FakeMetrics {
  const recorded: { type: NotificationType; outcome: DeliveryOutcome }[] = []
  return {
    recorded,
    delivered(type, outcome) {
      recorded.push({ type, outcome })
    },
  }
}

export interface World {
  readonly deps: NotificationDeps
  readonly notifications: FakeRepository
  readonly bookings: FakeBookings
  readonly vouchers: FakeVouchers
  readonly sender: FakeSender
  readonly metrics: FakeMetrics
  readonly clock: { value: Date }
  /** Menggeser jam. */
  advance(ms: number): void
}

export function world(
  options: {
    snapshots?: readonly BookingSnapshot[]
    voucherReady?: boolean
    ratePerHour?: number
  } = {},
): World {
  const notifications = fakeRepository()
  const bookings = fakeBookings(options.snapshots)
  const vouchers = fakeVouchers(options.voucherReady ?? true)
  const sender = fakeSender()
  const metrics = fakeMetrics()
  const clock = { value: START }

  const deps: NotificationDeps = {
    notifications,
    bookings,
    vouchers,
    sender,
    metrics,
    clock: { now: () => clock.value },
    policy: {
      ratePerHour: options.ratePerHour ?? 10,
      recipientKeySecret: 'rahasia-uji-yang-panjangnya-cukup-0001',
      batchSize: 10,
      leaseMs: 60_000,
    },
    logger: createLogger({ serviceName: 'notification-service-test', level: 'silent' }),
  }

  return {
    deps,
    notifications,
    bookings,
    vouchers,
    sender,
    metrics,
    clock,
    advance(ms) {
      clock.value = new Date(clock.value.getTime() + ms)
    },
  }
}

export function confirmationRequest(
  overrides: Partial<NotificationRequest> = {},
): NotificationRequest {
  return {
    bookingId: BOOKING_ID,
    userId: null,
    dedupeKey: `booking_confirmed:${BOOKING_ID}`,
    source: 'event',
    sourceMessageId: '018f2a1c-0000-7000-8000-0000000e0001',
    correlationId: 'corr-fake',
    context: { type: 'booking_confirmed' },
    ...overrides,
  }
}
