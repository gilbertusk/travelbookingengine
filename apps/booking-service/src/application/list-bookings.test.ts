import { describe, expect, test } from 'vitest'
import type { Booking, BookingStatus } from '../domain/booking.js'
import { BOOKING_GROUPS, groupOf, type BookingGroup } from '../domain/booking-groups.js'
import { parseLocalDate, stayDates, type LocalDate } from '../domain/stay-dates.js'
import { toRow } from '../infrastructure/booking-rows.js'
import { inState, sampleKey } from '../testing/builders.js'
import { harness, OTHER_USER, USER, type Harness } from '../testing/fakes.js'
import { listBookings } from './list-bookings.js'

/**
 * Daftar pemesanan pengguna (Step 26, FR-25). Jam harness: 1 Oktober 2026.
 */

let sequence = 0

function date(value: string): LocalDate {
  const parsed = parseLocalDate(value)
  if (parsed === undefined) throw new Error(`bukan tanggal: ${value}`)
  return parsed
}

/** Satu pemesanan pada keadaan dan tanggal menginap tertentu, langsung ke tabel. */
function seed(
  world: Harness,
  status: BookingStatus,
  options: { checkIn?: string; checkOut?: string; userId?: string; updatedAt?: Date } = {},
): Booking {
  sequence += 1
  const suffix = String(sequence).padStart(12, '0')
  const stay = stayDates({
    checkIn: options.checkIn ?? '2026-11-10',
    checkOut: options.checkOut ?? '2026-11-12',
  })
  if (!stay.ok) throw new Error('tanggal contoh tidak sah')
  const booking: Booking = {
    ...inState(status),
    id: `5e5e5e5e-0000-4000-8000-${suffix}`,
    userId: options.userId ?? USER,
    idempotencyKey: sampleKey(suffix),
    stay: stay.value,
    ...(options.updatedAt === undefined ? {} : { updatedAt: options.updatedAt }),
  }
  world.db.committed().bookings.set(booking.id, toRow(booking))

  return booking
}

async function ids(world: Harness, group: BookingGroup): Promise<string[]> {
  const page = await listBookings(world.deps, { userId: USER, group, limit: 50 })
  if (page.kind !== 'page') throw new Error(`bukan halaman: ${page.kind}`)

  return page.items.map((item) => item.booking.id)
}

describe('kelompok pemesanan', () => {
  test('akan datang: berproses kapan pun, dan terkonfirmasi yang belum lewat, urut tanggal masuk', async () => {
    const world = harness()
    const later = seed(world, 'CONFIRMED', { checkIn: '2026-12-01', checkOut: '2026-12-03' })
    const sooner = seed(world, 'CONFIRMED', { checkIn: '2026-10-20', checkOut: '2026-10-22' })
    const reviewInPast = seed(world, 'NEEDS_REVIEW', {
      checkIn: '2026-09-01',
      checkOut: '2026-09-03',
    })
    seed(world, 'CONFIRMED', { checkIn: '2026-09-10', checkOut: '2026-09-12' })

    expect(await ids(world, 'upcoming')).toEqual([reviewInPast.id, sooner.id, later.id])
  })

  test('selesai: terkonfirmasi yang tanggal keluarnya sudah lewat, terbaru lebih dulu', async () => {
    const world = harness()
    const older = seed(world, 'CONFIRMED', { checkIn: '2026-08-01', checkOut: '2026-08-03' })
    const recent = seed(world, 'CONFIRMED', { checkIn: '2026-09-10', checkOut: '2026-09-12' })

    expect(await ids(world, 'past')).toEqual([recent.id, older.id])
  })

  test('dibatalkan: batal, kedaluwarsa, gagal, dan dikembalikan, perubahan terakhir lebih dulu', async () => {
    const world = harness()
    const statuses: BookingStatus[] = ['CANCELLED', 'EXPIRED', 'FAILED', 'REFUNDED']
    const seeded = statuses.map((status, index) =>
      seed(world, status, { updatedAt: new Date(Date.UTC(2026, 8, 1 + index)) }),
    )

    expect(await ids(world, 'cancelled')).toEqual(seeded.map((booking) => booking.id).reverse())
  })

  test('harga yang hanya diperiksa tidak pernah muncul', async () => {
    const world = harness()
    seed(world, 'DRAFT')
    seed(world, 'PRICE_CHECKED')

    for (const group of BOOKING_GROUPS) expect(await ids(world, group)).toEqual([])
  })

  test('pemesanan pengguna lain tidak pernah muncul', async () => {
    const world = harness()
    seed(world, 'CONFIRMED', { userId: OTHER_USER })

    expect(await ids(world, 'upcoming')).toEqual([])
  })

  test('kueri dan pengelompokan domain sepakat untuk setiap keadaan', async () => {
    // Kelompok dinyatakan dua kali — sebagai kueri di repository dan sebagai
    // fungsi di domain. Uji ini yang menjaga keduanya tidak berpisah.
    const world = harness()
    const today = date('2026-10-01')
    const seeded = (
      [
        'DRAFT',
        'PRICE_CHECKED',
        'HELD',
        'PAID',
        'CONFIRMED',
        'CANCELLING',
        'FAILED',
        'REFUNDED',
        'CANCELLED',
        'EXPIRED',
        'NEEDS_REVIEW',
      ] as const
    ).flatMap((status) => [
      seed(world, status),
      seed(world, status, { checkIn: '2026-09-01', checkOut: '2026-09-03' }),
    ])

    for (const group of BOOKING_GROUPS) {
      const expected = seeded.filter((booking) => groupOf(booking, today) === group)
      expect(new Set(await ids(world, group)), group).toEqual(
        new Set(expected.map((booking) => booking.id)),
      )
    }
  })
})

describe('halaman', () => {
  test('dimuat bertahap dengan penunjuk halaman berikutnya', async () => {
    const world = harness()
    for (let day = 10; day < 15; day += 1) {
      seed(world, 'CONFIRMED', { checkIn: `2026-11-${String(day)}`, checkOut: '2026-11-20' })
    }

    const first = await listBookings(world.deps, { userId: USER, group: 'upcoming', limit: 2 })
    if (first.kind !== 'page' || first.nextCursor === null) throw new Error('halaman pertama')
    const second = await listBookings(world.deps, {
      userId: USER,
      group: 'upcoming',
      limit: 2,
      cursor: first.nextCursor,
    })
    if (second.kind !== 'page' || second.nextCursor === null) throw new Error('halaman kedua')
    const last = await listBookings(world.deps, {
      userId: USER,
      group: 'upcoming',
      limit: 2,
      cursor: second.nextCursor,
    })

    const checkIns = [first, second, last].flatMap((page) =>
      page.kind === 'page' ? page.items.map((item) => item.booking.stay.checkIn) : [],
    )
    expect(checkIns).toEqual(['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14'])
    expect(last.kind === 'page' && last.nextCursor).toBeNull()
  })

  test.each(['-1', 'abc', '1.5', ''])('penunjuk %j ditolak', async (cursor) => {
    const world = harness()

    expect(
      await listBookings(world.deps, { userId: USER, group: 'upcoming', limit: 10, cursor }),
    ).toEqual({ kind: 'invalid_cursor' })
  })
})

describe('nama properti dari katalog', () => {
  test('setiap entri membawa nama properti, ditanyakan sekali per properti', async () => {
    const world = harness()
    seed(world, 'CONFIRMED')
    seed(world, 'CONFIRMED', { checkIn: '2026-12-01', checkOut: '2026-12-03' })

    const page = await listBookings(world.deps, { userId: USER, group: 'upcoming', limit: 10 })

    expect(page.kind === 'page' && page.items.map((item) => item.propertyName)).toEqual([
      'Villa Sawah Ubud',
      'Villa Sawah Ubud',
    ])
    expect(world.properties.lookups).toEqual(['SKY/prop-bali-001'])
  })

  test('katalog yang tidak menjawab tidak menggagalkan daftar', async () => {
    const world = harness()
    seed(world, 'CONFIRMED')
    world.properties.answer = { kind: 'unreachable' }

    const page = await listBookings(world.deps, { userId: USER, group: 'upcoming', limit: 10 })

    expect(page.kind === 'page' && page.items.map((item) => item.propertyName)).toEqual([null])
  })
})
