import { money } from '@tbe/money'
import { describe, expect, test } from 'vitest'
import {
  harness,
  HOLD_DURATION_MS,
  OTHER_USER,
  priceCheckRequest,
  racyHoldStore,
  USER,
  type Harness,
} from '../testing/fakes.js'
import type { Booking } from '../domain/booking.js'
import { applyCommand } from '../domain/transitions.js'
import { placeHold, slotOf } from './place-hold.js'
import { acceptPriceChange, startPriceCheck } from './price-check.js'

/** Slot yang dipesan setiap `priceCheckRequest` contoh. */
const SAMPLE_SLOT = 'SKY|SKY-RP-DLX-BB|2026-11-10|2026-11-12'

async function verified(
  world: Harness,
  key = 'req-2026-10-01-0001',
  userId = USER,
): Promise<Booking> {
  const result = await startPriceCheck(world.deps, priceCheckRequest({ key, userId }))
  if (result.kind !== 'checked') throw new Error(`persiapan gagal: ${result.kind}`)
  return result.booking
}

async function hold(world: Harness, booking: Booking, unitsLeft = 5) {
  return await placeHold(world.deps, { userId: booking.userId, bookingId: booking.id, unitsLeft })
}

describe('hold dua lapis', () => {
  test('hold berhasil menahan lokal dan di supplier, lalu tersimpan HELD', async () => {
    const world = harness()
    const booking = await verified(world)

    const result = await hold(world, booking)

    expect(result.kind).toBe('held')
    if (result.kind !== 'held') return
    expect(result.booking.status).toBe('HELD')
    expect(world.holds.held(slotOf(booking))).toBe(1)
    expect(world.suppliers.holds).toEqual([
      {
        supplier: 'SKY',
        supplierRatePlanId: 'SKY-RP-DLX-BB',
        checkIn: '2026-11-10',
        checkOut: '2026-11-12',
        guests: 2,
      },
    ])
  })

  test('batas waktu hold adalah yang lebih awal: lokal', async () => {
    const world = harness()
    const booking = await verified(world)

    const result = await hold(world, booking)

    // Supplier palsuan menahan 20 menit; lokal 15 menit.
    expect(result.kind === 'held' && result.booking.heldUntil).toEqual(
      new Date(world.now().getTime() + HOLD_DURATION_MS),
    )
  })

  test('batas waktu hold adalah yang lebih awal: supplier, dan kunci lokal dimajukan', async () => {
    const world = harness()
    const booking = await verified(world)
    const supplierExpiry = new Date(world.now().getTime() + 5 * 60 * 1_000)
    world.suppliers.nextHold({
      kind: 'ok',
      value: {
        holdRef: 'sky-hold-short',
        expiresAt: supplierExpiry,
        total: money(2_000_000, 'IDR'),
      },
    })

    const result = await hold(world, booking)

    expect(result.kind === 'held' && result.booking.heldUntil).toEqual(supplierExpiry)
    expect(world.holds.slots.locks.get(booking.id)?.until).toBe(supplierExpiry.getTime())
  })

  test('pengulangan hold yang sudah berhasil dijawab dengan hasilnya tanpa hold kedua', async () => {
    const world = harness()
    const booking = await verified(world)
    await hold(world, booking)

    const again = await hold(world, booking)

    expect(again.kind).toBe('held')
    expect(world.suppliers.holds).toHaveLength(1)
  })
})

describe('US-04: seratus permintaan serentak untuk ketersediaan sepuluh', () => {
  /**
   * Seratus price check dan hold di atas basis data palsuan yang menyalin
   * seluruh tabelnya pada setiap transaksi — sejak Step 19 termasuk outbox dan
   * saga yang ikut bertambah. Sendirian dua detik; di bawah `pnpm test`
   * seluruh repo melewati batas bawaan lima detik.
   */
  const HUNDRED_REQUESTS_TIMEOUT_MS = 30_000

  async function hundredBookings(world: Harness): Promise<Booking[]> {
    const keys = Array.from(
      { length: 100 },
      (_, index) => `req-2026-10-01-${String(index).padStart(4, '0')}`,
    )
    return await Promise.all(keys.map(async (key) => await verified(world, key)))
  }

  test(
    'tepat sepuluh yang tertahan, dan supplier hanya dipanggil sepuluh kali',
    async () => {
      const world = harness()
      const bookings = await hundredBookings(world)

      const results = await Promise.all(
        bookings.map(async (booking) => await hold(world, booking, 10)),
      )

      expect(results.filter((result) => result.kind === 'held')).toHaveLength(10)
      expect(results.filter((result) => result.kind === 'sold_out')).toHaveLength(90)
      expect(world.suppliers.holds).toHaveLength(10)
      expect(bookings.every((booking) => slotOf(booking) === SAMPLE_SLOT)).toBe(true)
      expect(world.holds.held(SAMPLE_SLOT)).toBe(10)
    },
    HUNDRED_REQUESTS_TIMEOUT_MS,
  )

  /**
   * Uji di atas tidak hampa. Hold store yang SAMA tetapi dengan titik tunggu di
   * antara membaca jumlah kursi dan menambah anggota — SCARD lalu SADD dari
   * klien, bukan dari skrip — menjual jauh lebih dari sepuluh.
   */
  test(
    'uji tidak hampa: pola periksa-lalu-tulis menjual lebih dari sepuluh',
    async () => {
      const world = harness({ holds: racyHoldStore() })
      const bookings = await hundredBookings(world)

      const results = await Promise.all(
        bookings.map(async (booking) => await hold(world, booking, 10)),
      )

      expect(results.filter((result) => result.kind === 'held').length).toBeGreaterThan(10)
    },
    HUNDRED_REQUESTS_TIMEOUT_MS,
  )

  test('kapasitas slot tidak dapat dinaikkan permintaan berikutnya', async () => {
    const world = harness()
    const first = await verified(world, 'req-2026-10-01-0001')
    const second = await verified(world, 'req-2026-10-01-0002')

    await hold(world, first, 1)
    const result = await hold(world, second, 50)

    expect(result.kind).toBe('sold_out')
  })
})

describe('pembebanan memakai harga yang disetujui (G2)', () => {
  test('harga supplier yang berubah saat hold membatalkan hold dan melepas kursi lokal', async () => {
    const world = harness()
    const booking = await verified(world)
    world.suppliers.nextHold({
      kind: 'ok',
      value: {
        holdRef: 'sky-hold-x',
        expiresAt: new Date(world.now().getTime() + 60_000 * 20),
        total: money(2_050_000, 'IDR'),
      },
    })

    const result = await hold(world, booking)

    expect(result.kind).toBe('price_changed')
    expect(world.holds.held(slotOf(booking))).toBe(0)
    expect((await world.deps.bookings.findById(booking.id))?.status).toBe('PRICE_CHECKED')
  })

  test('hold setelah persetujuan harga baru tertahan dengan harga yang disetujui itu', async () => {
    const world = harness()
    world.suppliers.supplierTotal = money(2_100_000, 'IDR')
    const booking = await verified(world)
    const accepted = await acceptPriceChange(world.deps, { userId: USER, bookingId: booking.id })
    if (accepted.kind !== 'checked') throw new Error('persiapan gagal')

    const result = await hold(world, accepted.booking)

    expect(result.kind === 'held' && result.booking.price.total).toEqual(money(2_564_100, 'IDR'))
  })

  test('hold ditolak sebelum menyentuh apa pun bila harga belum disetujui', async () => {
    const world = harness()
    world.suppliers.supplierTotal = money(2_100_000, 'IDR')
    const booking = await verified(world)

    const result = await hold(world, booking)

    expect(result.kind).toBe('refused')
    expect(world.suppliers.holds).toHaveLength(0)
    expect(world.holds.held(slotOf(booking))).toBe(0)
  })
})

describe('kompensasi setiap langkah', () => {
  test.each([
    ['supplier menolak', { kind: 'rejected', reason: 'sold_out' } as const, 'sold_out'],
    ['supplier tidak menjawab', { kind: 'unreachable' } as const, 'retry_later'],
  ])('%s: kursi lokal dilepas', async (_name, answer, expected) => {
    const world = harness()
    const booking = await verified(world)
    world.suppliers.nextHold(answer)

    const result = await hold(world, booking)

    expect(result.kind).toBe(expected)
    expect(world.holds.held(slotOf(booking))).toBe(0)
  })

  test('pricing-service gagal saat hold: kursi lokal dilepas', async () => {
    const world = harness()
    const booking = await verified(world)
    world.pricing.failNext()

    const result = await hold(world, booking)

    expect(result.kind).toBe('retry_later')
    expect(world.holds.held(slotOf(booking))).toBe(0)
  })

  test('hold supplier yang sudah kedaluwarsa saat tiba: ditolak domain, kursi lokal dilepas', async () => {
    const world = harness()
    const booking = await verified(world)
    world.suppliers.nextHold({
      kind: 'ok',
      value: { holdRef: 'sky-hold-late', expiresAt: world.now(), total: money(2_000_000, 'IDR') },
    })

    const result = await hold(world, booking)

    expect(result.kind).toBe('refused')
    expect(world.holds.held(slotOf(booking))).toBe(0)
  })

  test('pemesanan dibatalkan di tengah hold: kursi lokal dilepas', async () => {
    const world = harness()
    const booking = await verified(world)
    world.suppliers.nextHold(() => {
      // Pembatalan pengguna tiba tepat saat supplier sedang dihubungi —
      // lewat transisi domain sungguhan, bukan baris yang disusun tangan.
      const cancelled = applyCommand(booking, {
        type: 'cancel',
        at: world.now(),
        reason: 'user_request',
      })
      if (!cancelled.ok) throw new Error('persiapan gagal')
      void world.deps.bookings.save(cancelled.value)
      return {
        kind: 'ok',
        value: {
          holdRef: 'sky-hold-y',
          expiresAt: new Date(world.now().getTime() + 600_000),
          total: money(2_000_000, 'IDR'),
        },
      }
    })

    const result = await hold(world, booking)

    expect(result.kind).toBe('in_progress')
    expect(world.holds.held(slotOf(booking))).toBe(0)
  })

  test('hold kedua yang sedang berjalan untuk pemesanan yang sama tidak menahan dua kali di supplier', async () => {
    const world = harness()
    const booking = await verified(world)

    const [a, b] = await Promise.all([hold(world, booking), hold(world, booking)])

    expect([a.kind, b.kind].sort()).toEqual(['held', 'in_progress'])
    expect(world.suppliers.holds).toHaveLength(1)
  })
})

describe('kepemilikan', () => {
  test('hold atas pemesanan orang lain dijawab seperti pemesanan yang tidak ada', async () => {
    const world = harness()
    const booking = await verified(world)

    const result = await placeHold(world.deps, {
      userId: OTHER_USER,
      bookingId: booking.id,
      unitsLeft: 5,
    })

    expect(result).toEqual({ kind: 'not_found' })
    expect(world.suppliers.holds).toHaveLength(0)
  })
})
