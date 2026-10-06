import { describe, expect, test, vi } from 'vitest'
import { ApiError } from '@/lib/api-error'
import { parseCriteria } from '@/features/search/criteria'
import type { Offer } from '@/features/search/types'
import { sampleBooking } from '@/testing/booking'
import type { PriceCheckInput } from './api'
import { createBookingFlow, type FlowDeps, type PaymentOutcome } from './flow-controller'
import type { Selection } from './selection'
import type { Booking, PaymentStart } from './types'

const IDR = (amountMinor: number) => ({ amountMinor, currency: 'IDR' as const })
const GUEST = { fullName: 'Budi Santoso', email: 'budi@example.test' }

const OFFER: Offer = {
  supplier: 'SKY',
  supplierPropertyId: 'sky-123',
  supplierRatePlanId: 'SKY-RP-1',
  roomTypeName: 'Deluxe',
  ratePlanName: 'Termasuk sarapan',
  refundable: true,
  breakfastIncluded: true,
  unitsLeft: 4,
  total: IDR(2_442_000),
  base: IDR(2_000_000),
  markup: IDR(200_000),
  tax: IDR(242_000),
  taxName: 'PPN 11%',
}

function selection(overrides: Partial<Selection> = {}): Selection {
  const criteria = parseCriteria(
    new URLSearchParams('kota=Bali&mulai=2026-11-10&selesai=2026-11-12'),
  )
  if (criteria === undefined) throw new Error('kriteria contoh tidak sah')
  return { slug: 'padma', supplier: 'SKY', ratePlanId: 'SKY-RP-1', criteria, ...overrides }
}

const HELD = sampleBooking({
  status: 'HELD',
  heldUntil: '2026-10-06T10:15:00.000Z',
  priceCheck: null,
  // Server berkata 10:00:00, jam lokal (di bawah) 09:55:00.
  serverTime: '2026-10-06T10:00:00.000Z',
})

const changed = (current: number): Booking =>
  sampleBooking({
    priceCheck: {
      outcome: 'changed',
      previous: IDR(2_442_000),
      current: IDR(current),
      difference: IDR(current - 2_442_000),
    },
  })

const PAYMENT: PaymentStart = {
  paymentId: 'pay-1',
  redirectUrl: 'https://snap.example/r/1',
  snapToken: 'tok-1',
  booking: HELD,
}

const conflict = (code: string) =>
  new ApiError({ kind: 'client', status: 409, code, message: code })

interface World {
  readonly deps: FlowDeps
  readonly calls: string[]
  readonly navigations: string[]
  readonly storage: Map<string, string>
}

function world(
  overrides: Partial<FlowDeps['api']> = {},
  outcome: PaymentOutcome = 'success',
): World {
  const calls: string[] = []
  const navigations: string[] = []
  const storage = new Map<string, string>()
  let keys = 0

  const deps: FlowDeps = {
    api: {
      priceCheck: vi.fn(async (input: PriceCheckInput) => {
        calls.push(`check:${input.idempotencyKey}`)
        return await Promise.resolve(sampleBooking())
      }),
      acceptPrice: vi.fn(async () => {
        calls.push('accept')
        return await Promise.resolve(sampleBooking())
      }),
      placeHold: vi.fn(async (_id: string, unitsLeft: number) => {
        calls.push(`hold:${String(unitsLeft)}`)
        return await Promise.resolve(HELD)
      }),
      fetchBooking: vi.fn(async () => {
        calls.push('fetch')
        return await Promise.resolve(HELD)
      }),
      startPayment: vi.fn(async () => {
        calls.push('pay')
        return await Promise.resolve(PAYMENT)
      }),
      ...overrides,
    },
    navigate: {
      replace: (href) => navigations.push(`replace:${href}`),
      push: (href) => navigations.push(`push:${href}`),
    },
    openPayment: async () => await Promise.resolve(outcome),
    storage: {
      get: (key) => storage.get(key),
      set: (key, value) => storage.set(key, value),
      remove: (key) => storage.delete(key),
    },
    now: () => Date.parse('2026-10-06T09:55:00.000Z'),
    newKey: () => {
      keys += 1
      return `key-${String(keys)}`
    },
    currentParams: () => new URLSearchParams('properti=padma'),
  }

  return { deps, calls, navigations, storage }
}

/** Menunggu sampai seluruh janji yang sedang berjalan selesai. */
async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('alur tanpa perubahan harga', () => {
  test('data tamu → price check → hold → hitung mundur dengan jam server', async () => {
    const { deps, calls, navigations } = world()
    const flow = createBookingFlow(selection(), OFFER, deps)

    flow.submitGuest(GUEST)
    await settle()

    expect(calls).toEqual(['check:key-1', 'hold:4'])
    expect(flow.getState().step).toEqual({ step: 'held', booking: HELD })
    // Jam lokal terlambat lima menit; hitung mundur memakai jam server.
    expect(flow.getState().offsetMs).toBe(5 * 60_000)
    // Pemesanan masuk URL supaya dapat dilanjutkan setelah dimuat ulang.
    expect(navigations).toEqual([`replace:/bookings/pesan?properti=padma&pesanan=${HELD.id}`])
  })

  test('harga yang dikirim adalah harga yang DILIHAT pengguna, bukan harga yang dihitung ulang', async () => {
    const { deps } = world()
    const flow = createBookingFlow(selection(), OFFER, deps)

    flow.submitGuest(GUEST)
    await settle()

    expect(deps.api.priceCheck).toHaveBeenCalledWith(
      expect.objectContaining({ displayedTotal: OFFER.total, guest: GUEST, guests: 2 }),
    )
  })

  test('kirim ulang memakai kunci idempotensi yang sama — satu pemesanan (FR-18)', async () => {
    const failing = world({
      priceCheck: vi.fn(async (input: PriceCheckInput) => {
        await Promise.resolve()
        throw new ApiError({ kind: 'network', status: 0, code: input.idempotencyKey, message: 'x' })
      }),
    })
    const flow = createBookingFlow(selection(), OFFER, failing.deps)

    flow.submitGuest(GUEST)
    await settle()
    flow.retry()
    await settle()

    const keys = vi
      .mocked(failing.deps.api.priceCheck)
      .mock.calls.map(([input]) => input.idempotencyKey)
    expect(keys).toEqual(['key-1', 'key-1'])
    expect(flow.getState().step).toMatchObject({ step: 'failed', retry: 'check' })
  })
})

describe('harga berubah (US-02)', () => {
  test('dialog muncul dengan harga lama, baru, dan selisih', async () => {
    const { deps, calls } = world({
      priceCheck: async () => await Promise.resolve(changed(2_600_000)),
    })
    const flow = createBookingFlow(selection(), OFFER, deps)

    flow.submitGuest(GUEST)
    await settle()

    expect(flow.getState()).toMatchObject({
      step: {
        step: 'rate_changed',
        previous: IDR(2_442_000),
        current: IDR(2_600_000),
        difference: IDR(158_000),
      },
      rateDialogOpen: true,
    })
    // Tidak ada hold sebelum pengguna menyetujui.
    expect(calls).not.toContain('hold:4')
  })

  test('harga berubah LAGI setelah disetujui: dialog muncul lagi dengan angka baru', async () => {
    const { deps } = world({
      priceCheck: async () => await Promise.resolve(changed(2_600_000)),
      acceptPrice: async () => await Promise.resolve(changed(2_700_000)),
    })
    const flow = createBookingFlow(selection(), OFFER, deps)
    flow.submitGuest(GUEST)
    await settle()

    flow.acceptNewPrice()
    await settle()

    expect(flow.getState()).toMatchObject({
      step: { step: 'rate_changed', current: IDR(2_700_000) },
      rateDialogOpen: true,
      accepting: false,
    })
  })

  test('disetujui dan terverifikasi: dialog tertutup, kamar ditahan', async () => {
    const { deps, calls } = world({
      priceCheck: async () => await Promise.resolve(changed(2_600_000)),
    })
    const flow = createBookingFlow(selection(), OFFER, deps)
    flow.submitGuest(GUEST)
    await settle()

    flow.acceptNewPrice()
    await settle()

    expect(calls).toContain('hold:4')
    expect(flow.getState()).toMatchObject({ step: { step: 'held' }, rateDialogOpen: false })
  })

  test('menutup dialog dengan Escape BUKAN menolak: pemesanan tetap menunggu persetujuan', async () => {
    const { deps } = world({ priceCheck: async () => await Promise.resolve(changed(2_600_000)) })
    const flow = createBookingFlow(selection(), OFFER, deps)
    flow.submitGuest(GUEST)
    await settle()

    flow.setRateDialogOpen(false)

    expect(flow.getState()).toMatchObject({ step: { step: 'rate_changed' }, rateDialogOpen: false })
  })

  test('harga bergerak tepat saat hold: price check lagi, lalu dialog', async () => {
    let checks = 0
    const { deps } = world({
      priceCheck: async () => {
        checks += 1
        return await Promise.resolve(checks === 1 ? sampleBooking() : changed(2_500_000))
      },
      placeHold: async () => {
        await Promise.resolve()
        throw conflict('PRICE_CHANGED')
      },
    })
    const flow = createBookingFlow(selection(), OFFER, deps)

    flow.submitGuest(GUEST)
    await settle()

    expect(flow.getState().step).toMatchObject({ step: 'rate_changed', current: IDR(2_500_000) })
  })
})

describe('jalan keluar', () => {
  test('kamar habis saat hold', async () => {
    const { deps } = world({
      placeHold: async () => {
        await Promise.resolve()
        throw conflict('SOLD_OUT')
      },
    })
    const flow = createBookingFlow(selection(), OFFER, deps)

    flow.submitGuest(GUEST)
    await settle()

    expect(flow.getState().step).toEqual({ step: 'unavailable', reason: 'sold_out' })
  })

  test('hold gagal sementara: coba lagi mengulang HOLD, bukan price check', async () => {
    let holds = 0
    const { deps, calls } = world({
      placeHold: async () => {
        holds += 1
        if (holds === 1) {
          throw new ApiError({
            kind: 'server',
            status: 503,
            code: 'SUPPLIER_UNAVAILABLE',
            message: 'x',
          })
        }
        return await Promise.resolve(HELD)
      },
    })
    const flow = createBookingFlow(selection(), OFFER, deps)
    flow.submitGuest(GUEST)
    await settle()
    expect(flow.getState().step).toMatchObject({ step: 'failed', retry: 'hold' })

    flow.retry()
    await settle()

    expect(calls.filter((call) => call.startsWith('check'))).toHaveLength(1)
    expect(flow.getState().step).toMatchObject({ step: 'held' })
  })

  test('hold yang sedang diproses tab lain: keadaannya dibaca dan diikuti', async () => {
    const { deps } = world({
      placeHold: async () => {
        await Promise.resolve()
        throw conflict('HOLD_IN_PROGRESS')
      },
    })
    const flow = createBookingFlow(selection(), OFFER, deps)

    flow.submitGuest(GUEST)
    await settle()

    expect(flow.getState().step).toMatchObject({ step: 'held' })
  })

  test('hitung mundur habis', () => {
    const { deps } = world()
    const flow = createBookingFlow(selection(), OFFER, deps)

    flow.expire()

    expect(flow.getState().step).toEqual({ step: 'expired' })
  })
})

describe('pembayaran', () => {
  async function held(w: World) {
    const flow = createBookingFlow(selection(), OFFER, w.deps)
    flow.submitGuest(GUEST)
    await settle()
    return flow
  }

  test('popup selesai: ke halaman status — status dibaca dari server, bukan dari popup', async () => {
    const w = world()
    const flow = await held(w)

    flow.pay()
    await settle()

    expect(w.navigations.at(-1)).toBe(`push:/bookings/${HELD.id}?bayar=selesai`)
  })

  test('popup ditutup: tetap di halaman, kamar masih tertahan', async () => {
    const w = world({}, 'closed')
    const flow = await held(w)

    flow.pay()
    await settle()

    expect(flow.getState()).toMatchObject({
      step: { step: 'held' },
      paymentClosed: true,
      paying: false,
    })
    expect(w.navigations.filter((href) => href.startsWith('push'))).toEqual([])
  })

  test('halaman Snap penuh: tidak berpindah ke mana pun dari sini', async () => {
    const w = world({}, 'redirected')
    const flow = await held(w)

    flow.pay()
    await settle()

    expect(w.navigations.filter((href) => href.startsWith('push'))).toEqual([])
  })

  test('sudah dibayar: ke halaman status', async () => {
    const w = world({
      startPayment: async () => {
        await Promise.resolve()
        throw conflict('ALREADY_PAID')
      },
    })
    const flow = await held(w)

    flow.pay()
    await settle()

    expect(w.navigations.at(-1)).toBe(`push:/bookings/${HELD.id}`)
  })

  test('hold habis saat membuka pembayaran', async () => {
    const w = world({
      startPayment: async () => {
        await Promise.resolve()
        throw conflict('HOLD_EXPIRED')
      },
    })
    const flow = await held(w)

    flow.pay()
    await settle()

    expect(flow.getState().step).toEqual({ step: 'expired' })
  })

  test('gagal membuka: coba lagi kembali ke langkah bayar', async () => {
    const w = world({
      startPayment: async () => {
        await Promise.resolve()
        throw new ApiError({
          kind: 'server',
          status: 503,
          code: 'PAYMENT_UNAVAILABLE',
          message: 'x',
        })
      },
    })
    const flow = await held(w)
    flow.pay()
    await settle()
    expect(flow.getState().step).toMatchObject({ step: 'failed', retry: 'pay' })

    flow.retry()

    expect(flow.getState().step).toMatchObject({ step: 'held' })
  })
})

describe('melanjutkan setelah dimuat ulang', () => {
  test('pemesanan HELD: langsung ke hitung mundur', async () => {
    const { deps } = world()
    const flow = createBookingFlow(selection({ bookingId: HELD.id }), OFFER, deps)

    flow.resume(new AbortController().signal)
    await settle()

    expect(flow.getState().step).toMatchObject({ step: 'held' })
  })

  test('pemesanan yang sudah dibayar: ke halaman status', async () => {
    const { deps, navigations } = world({
      fetchBooking: async () => await Promise.resolve(sampleBooking({ status: 'PAID' })),
    })
    const flow = createBookingFlow(selection({ bookingId: 'b-1' }), OFFER, deps)

    flow.resume(new AbortController().signal)
    await settle()

    expect(navigations.at(-1)).toMatch(/^replace:\/bookings\//)
  })

  test('masih butuh price check: data tamu diminta lagi, tidak disimpan di peramban', async () => {
    const { deps } = world({
      fetchBooking: async () =>
        await Promise.resolve(sampleBooking({ priceCheck: { outcome: 'awaiting_recheck' } })),
    })
    const flow = createBookingFlow(selection({ bookingId: 'b-1' }), OFFER, deps)

    flow.resume(new AbortController().signal)
    await settle()

    expect(flow.getState().step).toEqual({ step: 'details' })
  })
})
