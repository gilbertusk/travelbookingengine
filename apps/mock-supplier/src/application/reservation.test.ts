import { describe, expect, test } from 'vitest'
import { DEFAULT_HOLD_TTL_MS } from '../domain/booking.js'
import { coversProperty } from '../domain/supplier.js'
import { createHarness, STAY, type Harness } from '../testing/harness.js'
import { NEUTRAL_CHAOS } from './chaos.js'
import { book, cancel, findBooking, hold, priceCheck, sweepExpiredHolds } from './reservation.js'
import { unitsLeftFor } from './search.js'
import { enumerateNights } from '../domain/stay.js'

const SUPPLIER = 'SKY' as const

function firstCoveredRatePlanId(harness: Harness): string {
  const nights = enumerateNights(STAY.checkIn, STAY.checkOut)

  const found = harness.context.catalog
    .allRatePlans()
    .find(
      (ratePlan) =>
        coversProperty(SUPPLIER, ratePlan.propertyId) &&
        unitsLeftFor(harness.context.deps, ratePlan.id, nights) > 0,
    )

  if (found === undefined) throw new Error('tidak ada rate plan yang tersedia untuk pengujian')
  return found.id
}

function holdOnce(harness: Harness, ratePlanId: string, ttlMs?: number) {
  return hold(harness.context.deps, {
    supplier: SUPPLIER,
    ratePlanId,
    checkIn: STAY.checkIn,
    checkOut: STAY.checkOut,
    guests: 2,
    ttlMs,
  })
}

describe('hold', () => {
  test('mengurangi ketersediaan untuk seluruh malam menginap', () => {
    const harness = createHarness()
    const ratePlanId = firstCoveredRatePlanId(harness)
    const nights = enumerateNights(STAY.checkIn, STAY.checkOut)
    const sebelum = unitsLeftFor(harness.context.deps, ratePlanId, nights)

    const result = holdOnce(harness, ratePlanId)

    expect(result.ok).toBe(true)
    expect(unitsLeftFor(harness.context.deps, ratePlanId, nights)).toBe(sebelum - 1)
  })

  test('menolak ketika seluruh unit sudah tertahan', () => {
    // Arrange — habiskan seluruh unit yang tersedia
    const harness = createHarness()
    const ratePlanId = firstCoveredRatePlanId(harness)
    const nights = enumerateNights(STAY.checkIn, STAY.checkOut)
    const tersedia = unitsLeftFor(harness.context.deps, ratePlanId, nights)

    for (let index = 0; index < tersedia; index += 1) {
      expect(holdOnce(harness, ratePlanId).ok).toBe(true)
    }

    // Act
    const berlebih = holdOnce(harness, ratePlanId)

    // Assert
    expect(berlebih.ok).toBe(false)
    expect(berlebih.ok ? undefined : berlebih.error).toEqual({ kind: 'sold_out' })
  })

  test('menolak rentang tanggal yang tidak sah', () => {
    const harness = createHarness()
    const result = hold(harness.context.deps, {
      supplier: SUPPLIER,
      ratePlanId: firstCoveredRatePlanId(harness),
      checkIn: '2026-11-12',
      checkOut: '2026-11-10',
      guests: 2,
    })

    expect(result.ok).toBe(false)
  })

  test('menolak rate plan yang tidak dijual supplier ini', () => {
    const harness = createHarness()
    const asing = harness.context.catalog
      .allRatePlans()
      .find((ratePlan) => !coversProperty(SUPPLIER, ratePlan.propertyId))

    const result = holdOnce(harness, asing?.id ?? 'tidak-ada')

    expect(result.ok).toBe(false)
  })
})

describe('kedaluwarsa hold', () => {
  test('mengembalikan unit setelah batas waktu terlampaui', () => {
    // Arrange
    const harness = createHarness()
    const ratePlanId = firstCoveredRatePlanId(harness)
    const nights = enumerateNights(STAY.checkIn, STAY.checkOut)
    const sebelum = unitsLeftFor(harness.context.deps, ratePlanId, nights)
    holdOnce(harness, ratePlanId)

    // Act — lewati batas waktu hold
    harness.advance(DEFAULT_HOLD_TTL_MS + 1_000)
    const dibersihkan = sweepExpiredHolds(harness.context.deps)

    // Assert
    expect(dibersihkan).toBe(1)
    expect(unitsLeftFor(harness.context.deps, ratePlanId, nights)).toBe(sebelum)
  })

  test('tidak melepas hold yang masih berlaku', () => {
    const harness = createHarness()
    holdOnce(harness, firstCoveredRatePlanId(harness))

    harness.advance(DEFAULT_HOLD_TTL_MS - 1_000)

    expect(sweepExpiredHolds(harness.context.deps)).toBe(0)
  })

  test('book pada hold yang sudah kedaluwarsa ditolak', () => {
    const harness = createHarness()
    const held = holdOnce(harness, firstCoveredRatePlanId(harness))
    const ref = held.ok ? held.value.ref : ''

    harness.advance(DEFAULT_HOLD_TTL_MS + 1_000)
    const result = book(harness.context.deps, {
      supplier: SUPPLIER,
      holdRef: ref,
      guestName: 'Budi',
      idempotencyKey: 'idem-kedaluwarsa',
    })

    expect(result.ok).toBe(false)
  })
})

describe('idempotency book', () => {
  test('kunci yang sama mengembalikan pemesanan yang sama, bukan yang baru', () => {
    // Inilah yang mencegah pemesanan ganda ketika percobaan ulang terjadi
    // setelah jawaban hilang di jaringan. Tanpa ini, kerugiannya uang nyata.
    const harness = createHarness()
    const held = holdOnce(harness, firstCoveredRatePlanId(harness))
    const holdRef = held.ok ? held.value.ref : ''
    const request = {
      supplier: SUPPLIER,
      holdRef,
      guestName: 'Budi',
      idempotencyKey: 'idem-sama',
    }

    const pertama = book(harness.context.deps, request)
    const kedua = book(harness.context.deps, request)

    expect(pertama.ok && kedua.ok).toBe(true)
    if (!pertama.ok || !kedua.ok) return
    expect(kedua.value.booking.ref).toBe(pertama.value.booking.ref)
    expect(pertama.value.replayed).toBe(false)
    expect(kedua.value.replayed).toBe(true)
  })

  test('kunci yang sama tetap dijawab setelah hold-nya kedaluwarsa', () => {
    // Percobaan ulang datang terlambat; yang menentukan jawabannya adalah
    // kuncinya, bukan keadaan hold yang sudah tidak ada lagi.
    const harness = createHarness()
    const held = holdOnce(harness, firstCoveredRatePlanId(harness))
    const request = {
      supplier: SUPPLIER,
      holdRef: held.ok ? held.value.ref : '',
      guestName: 'Budi',
      idempotencyKey: 'idem-terlambat',
    }
    const pertama = book(harness.context.deps, request)

    harness.advance(DEFAULT_HOLD_TTL_MS * 2)
    const ulang = book(harness.context.deps, request)

    expect(ulang.ok).toBe(true)
    expect(ulang.ok ? ulang.value.booking.ref : '').toBe(
      pertama.ok ? pertama.value.booking.ref : '',
    )
  })

  test('kunci berbeda pada hold yang sudah dipakai ditolak', () => {
    const harness = createHarness()
    const held = holdOnce(harness, firstCoveredRatePlanId(harness))
    const holdRef = held.ok ? held.value.ref : ''

    book(harness.context.deps, {
      supplier: SUPPLIER,
      holdRef,
      guestName: 'Budi',
      idempotencyKey: 'kunci-1',
    })
    const kedua = book(harness.context.deps, {
      supplier: SUPPLIER,
      holdRef,
      guestName: 'Budi',
      idempotencyKey: 'kunci-2',
    })

    expect(kedua.ok).toBe(false)
  })

  test('booking tidak mengembalikan unit yang sudah terjual', () => {
    const harness = createHarness()
    const ratePlanId = firstCoveredRatePlanId(harness)
    const nights = enumerateNights(STAY.checkIn, STAY.checkOut)
    const sebelum = unitsLeftFor(harness.context.deps, ratePlanId, nights)
    const held = holdOnce(harness, ratePlanId)

    book(harness.context.deps, {
      supplier: SUPPLIER,
      holdRef: held.ok ? held.value.ref : '',
      guestName: 'Budi',
      idempotencyKey: 'terjual',
    })
    harness.advance(DEFAULT_HOLD_TTL_MS * 2)
    sweepExpiredHolds(harness.context.deps)

    expect(unitsLeftFor(harness.context.deps, ratePlanId, nights)).toBe(sebelum - 1)
  })
})

describe('pemulihan status', () => {
  test('pemesanan dapat ditemukan lewat idempotency key', () => {
    // Jalan keluar dari ketidakpastian pada US-05: permintaan book melewati
    // batas waktu, dan satu-satunya cara aman mencari tahu hasilnya adalah
    // bertanya dengan kunci yang dipakainya.
    const harness = createHarness()
    const held = holdOnce(harness, firstCoveredRatePlanId(harness))
    const dibuat = book(harness.context.deps, {
      supplier: SUPPLIER,
      holdRef: held.ok ? held.value.ref : '',
      guestName: 'Budi',
      idempotencyKey: 'pulih-1',
    })

    const ditemukan = findBooking(harness.context.deps, {
      supplier: SUPPLIER,
      idempotencyKey: 'pulih-1',
    })

    expect(ditemukan.ok).toBe(true)
    expect(ditemukan.ok ? ditemukan.value.ref : '').toBe(dibuat.ok ? dibuat.value.booking.ref : '')
  })

  test('kunci yang belum pernah dipakai tidak ditemukan', () => {
    const harness = createHarness()

    const hasil = findBooking(harness.context.deps, {
      supplier: SUPPLIER,
      idempotencyKey: 'belum-pernah',
    })

    expect(hasil.ok).toBe(false)
  })

  test('pemesanan supplier lain tidak dapat dilihat', () => {
    const harness = createHarness()
    const held = holdOnce(harness, firstCoveredRatePlanId(harness))
    const dibuat = book(harness.context.deps, {
      supplier: SUPPLIER,
      holdRef: held.ok ? held.value.ref : '',
      guestName: 'Budi',
      idempotencyKey: 'milik-sky',
    })

    const hasil = findBooking(harness.context.deps, {
      supplier: 'NOVA',
      bookingRef: dibuat.ok ? dibuat.value.booking.ref : '',
    })

    expect(hasil.ok).toBe(false)
  })
})

describe('pembatalan', () => {
  test('mengembalikan unit ke ketersediaan', () => {
    const harness = createHarness()
    const ratePlanId = firstCoveredRatePlanId(harness)
    const nights = enumerateNights(STAY.checkIn, STAY.checkOut)
    const sebelum = unitsLeftFor(harness.context.deps, ratePlanId, nights)
    const held = holdOnce(harness, ratePlanId)
    const dibuat = book(harness.context.deps, {
      supplier: SUPPLIER,
      holdRef: held.ok ? held.value.ref : '',
      guestName: 'Budi',
      idempotencyKey: 'batal-1',
    })

    cancel(harness.context.deps, {
      supplier: SUPPLIER,
      bookingRef: dibuat.ok ? dibuat.value.booking.ref : '',
    })

    expect(unitsLeftFor(harness.context.deps, ratePlanId, nights)).toBe(sebelum)
  })

  test('pembatalan kedua ditolak', () => {
    const harness = createHarness()
    const held = holdOnce(harness, firstCoveredRatePlanId(harness))
    const dibuat = book(harness.context.deps, {
      supplier: SUPPLIER,
      holdRef: held.ok ? held.value.ref : '',
      guestName: 'Budi',
      idempotencyKey: 'batal-2',
    })
    const ref = dibuat.ok ? dibuat.value.booking.ref : ''

    cancel(harness.context.deps, { supplier: SUPPLIER, bookingRef: ref })
    const kedua = cancel(harness.context.deps, { supplier: SUPPLIER, bookingRef: ref })

    expect(kedua.ok).toBe(false)
    expect(kedua.ok ? undefined : kedua.error).toEqual({ kind: 'already_cancelled' })
  })
})

describe('price check', () => {
  test('tidak menggeser harga ketika keberuntungan tidak memihak', () => {
    const harness = createHarness({ random: 0.99 })
    const ratePlanId = firstCoveredRatePlanId(harness)

    const hasil = priceCheck(
      harness.context.deps,
      { supplier: SUPPLIER, ratePlanId, ...STAY },
      NEUTRAL_CHAOS,
    )

    expect(hasil.ok && hasil.value.changed).toBe(false)
  })

  test('menggeser harga dan mempertahankannya untuk permintaan berikutnya', () => {
    // Harga yang bergeser lalu kembali pada pemeriksaan berikutnya akan
    // membuat alur persetujuan harga pada FR-14 mustahil diuji.
    const harness = createHarness({ random: 0 })
    const ratePlanId = firstCoveredRatePlanId(harness)
    const request = { supplier: SUPPLIER, ratePlanId, ...STAY }

    const pertama = priceCheck(harness.context.deps, request, NEUTRAL_CHAOS)
    harness.setRandom(0.99)
    const kedua = priceCheck(harness.context.deps, request, NEUTRAL_CHAOS)

    expect(pertama.ok && pertama.value.changed).toBe(true)
    expect(kedua.ok ? kedua.value.totalMinorIdr : 0).toBe(
      pertama.ok ? pertama.value.totalMinorIdr : -1,
    )
  })

  test('harga yang sudah bergeser dipakai saat hold', () => {
    const harness = createHarness({ random: 0 })
    const ratePlanId = firstCoveredRatePlanId(harness)
    const dicek = priceCheck(
      harness.context.deps,
      { supplier: SUPPLIER, ratePlanId, ...STAY },
      NEUTRAL_CHAOS,
    )

    const held = holdOnce(harness, ratePlanId)

    expect(held.ok ? held.value.priceMinorIdr : 0).toBe(dicek.ok ? dicek.value.totalMinorIdr : -1)
  })

  test('menolak rate plan yang tidak dikenal', () => {
    const harness = createHarness()

    const hasil = priceCheck(
      harness.context.deps,
      { supplier: SUPPLIER, ratePlanId: 'tidak-ada', ...STAY },
      NEUTRAL_CHAOS,
    )

    expect(hasil.ok).toBe(false)
  })
})
