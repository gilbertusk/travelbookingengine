import { money } from '@tbe/money'
import { createLogger, UpstreamError } from '@tbe/shared-kernel'
import type {
  BookingDirectory,
  InsertOutcome,
  PropertyDirectory,
  SourceLookup,
  VoucherDeps,
  VoucherEvents,
  VoucherRepository,
  VoucherStorage,
} from '../application/ports.js'
import type { VoucherContent } from '../domain/voucher-content.js'
import type { Voucher, VoucherProperty, VoucherSource } from '../domain/voucher.js'

/**
 * Palsuan port voucher-service.
 *
 * Repository palsuan MENIRU batasan UNIK booking_id — baris kedua untuk
 * pemesanan yang sama ditolak dan pemenangnya dikembalikan — alih-alih hanya
 * mencatat panggilan. Uji idempotensi bertumpu pada perilaku itu.
 */

export const USER = '7b9e2d14-1f3a-4e5c-8d6b-2a1c0f9e8d7c'
export const OTHER_USER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
export const BOOKING_ID = '018f2a1c-0000-7000-8000-00000000b001'
export const CONFIRMED_AT = new Date('2026-10-07T03:00:00.000Z')

export function confirmedSource(overrides: Partial<VoucherSource> = {}): VoucherSource {
  return {
    bookingId: BOOKING_ID,
    userId: USER,
    status: 'CONFIRMED',
    supplier: 'SKY',
    supplierRef: 'SKY-BK-7F3A21',
    confirmedAt: CONFIRMED_AT,
    supplierPropertyId: 'sky-120804930',
    checkIn: '2026-11-10',
    checkOut: '2026-11-12',
    guestCount: 2,
    leadGuestName: 'Sari Wulandari',
    total: money(2_442_000, 'IDR'),
    lines: [
      { kind: 'room_night', description: 'Malam 10 Nov 2026', amount: money(1_100_000, 'IDR') },
      { kind: 'room_night', description: 'Malam 11 Nov 2026', amount: money(1_100_000, 'IDR') },
      { kind: 'tax', description: 'PPN 11%', amount: money(242_000, 'IDR') },
    ],
    terms: {
      roomTypeName: 'Deluxe King',
      ratePlanName: 'Refundable with Breakfast',
      breakfastIncluded: true,
      cancellationPolicy: { refundable: true, freeCancellationDays: 3 },
    },
    ...overrides,
  }
}

export const PROPERTY: VoucherProperty = {
  name: 'Padma Bali Boutique Hotel',
  address: 'Jalan Melati No. 12',
  city: 'Bali',
  phone: '+62 361 4021',
  email: 'reservasi@padma-bali.example',
}

export interface FakeBookings extends BookingDirectory {
  readonly sources: Map<string, VoucherSource>
  failNext: boolean
}

export function fakeBookings(
  sources: readonly VoucherSource[] = [confirmedSource()],
): FakeBookings {
  const map = new Map(sources.map((source) => [source.bookingId, source]))
  const fake: FakeBookings = {
    sources: map,
    failNext: false,
    async voucherSource(bookingId): Promise<SourceLookup> {
      if (fake.failNext) {
        fake.failNext = false
        throw new UpstreamError({ upstream: 'booking-service', message: 'mati sesaat' })
      }
      const source = map.get(bookingId)
      return await Promise.resolve(
        source === undefined ? { kind: 'not_found' } : { kind: 'found', source },
      )
    },
  }
  return fake
}

export function fakeProperties(property: VoucherProperty | undefined): PropertyDirectory {
  return {
    bySupplier: async () => await Promise.resolve(property),
  }
}

export interface FakeRepository extends VoucherRepository {
  readonly rows: Map<string, Voucher>
  /** Dijalankan tepat sebelum insert — untuk menyelipkan pemenang balapan. */
  beforeInsert?: () => void
}

export function fakeRepository(): FakeRepository {
  const rows = new Map<string, Voucher>()
  const fake: FakeRepository = {
    rows,
    async findByBookingId(bookingId) {
      return await Promise.resolve(rows.get(bookingId))
    },
    async insert(voucher): Promise<InsertOutcome> {
      fake.beforeInsert?.()
      const existing = rows.get(voucher.bookingId)
      if (existing !== undefined) return { kind: 'exists', existing }
      rows.set(voucher.bookingId, voucher)
      return await Promise.resolve({ kind: 'inserted' })
    },
  }
  return fake
}

export interface FakeStorage extends VoucherStorage {
  readonly objects: Map<string, Uint8Array>
  readonly signed: { key: string; ttl: number }[]
  failRemove: boolean
}

export function fakeStorage(): FakeStorage {
  const objects = new Map<string, Uint8Array>()
  const fake: FakeStorage = {
    objects,
    signed: [],
    failRemove: false,
    async put(key, pdf) {
      objects.set(key, pdf)
      await Promise.resolve()
    },
    async remove(key) {
      if (fake.failRemove) throw new Error('MinIO menolak penghapusan')
      objects.delete(key)
      await Promise.resolve()
    },
    async read(key) {
      const pdf = objects.get(key)
      if (pdf === undefined) throw new Error(`objek ${key} tidak ada`)
      return await Promise.resolve(pdf)
    },
    async signedUrl(key, ttl) {
      fake.signed.push({ key, ttl })
      return await Promise.resolve(
        `https://minio.test/vouchers/${key}?X-Amz-Expires=${String(ttl)}`,
      )
    },
  }
  return fake
}

export interface FakeEvents extends VoucherEvents {
  readonly published: { voucher: Voucher; latencyMs: number }[]
}

export function fakeEvents(): FakeEvents {
  const published: { voucher: Voucher; latencyMs: number }[] = []
  return {
    published,
    async issued(voucher, latencyMs) {
      published.push({ voucher, latencyMs })
      await Promise.resolve()
    },
  }
}

export interface World {
  readonly deps: VoucherDeps
  readonly bookings: FakeBookings
  readonly vouchers: FakeRepository
  readonly storage: FakeStorage
  readonly events: FakeEvents
  readonly latencies: number[]
  readonly rendered: VoucherContent[]
  readonly clock: { value: Date }
}

/** Empat detik sesudah konfirmasi — latensi M7 yang wajar. */
export const ISSUE_DELAY_MS = 4_000

export function world(
  options: { sources?: readonly VoucherSource[]; property?: VoucherProperty | null } = {},
): World {
  const bookings = fakeBookings(options.sources)
  const vouchers = fakeRepository()
  const storage = fakeStorage()
  const events = fakeEvents()
  const latencies: number[] = []
  const rendered: VoucherContent[] = []
  const clock = { value: new Date(CONFIRMED_AT.getTime() + ISSUE_DELAY_MS) }
  let id = 0
  let token = 0

  const deps: VoucherDeps = {
    bookings,
    properties: fakeProperties(
      options.property === null ? undefined : (options.property ?? PROPERTY),
    ),
    vouchers,
    storage,
    renderer: {
      async render(content) {
        rendered.push(content)
        return await Promise.resolve(new TextEncoder().encode(`%PDF ${content.bookingReference}`))
      },
    },
    events,
    metrics: { observeIssueLatency: (seconds) => latencies.push(seconds) },
    clock: { now: () => clock.value },
    ids: { next: () => `018f2a1c-0000-7000-8000-${String((id += 1)).padStart(12, '0')}` },
    tokens: { next: () => `${'A'.repeat(42)}${String((token += 1) % 10)}` },
    logger: createLogger({ serviceName: 'voucher-service-test', level: 'silent' }),
  }

  return { deps, bookings, vouchers, storage, events, latencies, rendered, clock }
}
