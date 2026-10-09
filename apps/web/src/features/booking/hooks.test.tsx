import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { parseCriteria } from '@/features/search/criteria'
import { sampleBooking, sampleStatus } from '@/testing/booking'
import type * as ApiModule from './api'
import type { Selection } from './selection'
import type * as SnapModule from './snap'
import type * as StreamModule from './status-stream'
import type { WatchOptions } from './status-stream'
import { openPayment, useBookingFlow } from './use-booking-flow'
import { useBookingStatus } from './use-booking-status'

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => router }))

const api = vi.hoisted(() => ({
  priceCheck: vi.fn(),
  acceptPrice: vi.fn(),
  placeHold: vi.fn(),
  fetchBooking: vi.fn(),
  fetchStatus: vi.fn(),
  startPayment: vi.fn(),
}))
vi.mock('./api', async (original) => ({ ...(await original<typeof ApiModule>()), ...api }))

const snap = vi.hoisted(() => ({ loadSnap: vi.fn(), openSnap: vi.fn() }))
vi.mock('./snap', async (original) => ({ ...(await original<typeof SnapModule>()), ...snap }))

const stream = vi.hoisted(() => ({ options: undefined as WatchOptions | undefined, stop: vi.fn() }))
vi.mock('./status-stream', async (original) => ({
  ...(await original<typeof StreamModule>()),
  watchBookingStatus: (options: WatchOptions) => {
    stream.options = options
    return stream.stop
  },
}))

function wrapper({ children }: { readonly children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

const PAYMENT = {
  paymentId: 'p-1',
  redirectUrl: 'https://snap.example/r/1',
  snapToken: 'tok-1',
  booking: sampleBooking({ status: 'HELD' }),
}

beforeEach(() => {
  for (const mock of [...Object.values(api), ...Object.values(snap), router.push, router.replace]) {
    mock.mockReset()
  }
  stream.options = undefined
})

describe('useBookingStatus', () => {
  test('rincian dari kueri, status dari aliran — dan aliran dihentikan saat halaman ditinggal', async () => {
    api.fetchBooking.mockResolvedValue(sampleBooking({ status: 'PAID' }))
    const { result, unmount } = renderHook(() => useBookingStatus('b-1'), { wrapper })

    await waitFor(() => {
      expect(result.current.booking?.status).toBe('PAID')
    })
    act(() => {
      stream.options?.onMode('live')
      stream.options?.onStatus(sampleStatus({ status: 'CONFIRMED', isFinal: true }))
    })

    expect(result.current.status?.status).toBe('CONFIRMED')
    expect(result.current.mode).toBe('live')
    unmount()
    expect(stream.stop).toHaveBeenCalled()
  })

  test('sesi yang tidak dapat diperbarui dilaporkan', () => {
    api.fetchBooking.mockResolvedValue(sampleBooking())
    const { result } = renderHook(() => useBookingStatus('b-1'), { wrapper })

    act(() => {
      stream.options?.onUnauthorized()
    })

    expect(result.current.sessionExpired).toBe(true)
  })
})

describe('useBookingFlow', () => {
  const criteria = parseCriteria(
    new URLSearchParams('kota=Bali&mulai=2026-11-10&selesai=2026-11-12'),
  )
  if (criteria === undefined) throw new Error('kriteria contoh tidak sah')
  const selection: Selection = { slug: 'padma', supplier: 'SKY', ratePlanId: 'SKY-RP-1', criteria }

  test('melanjutkan pemesanan dari URL saat dimuat', async () => {
    api.fetchBooking.mockResolvedValue(
      sampleBooking({ status: 'HELD', heldUntil: '2099-01-01T00:00:00.000Z' }),
    )
    const { result } = renderHook(
      () => useBookingFlow({ ...selection, bookingId: 'b-1' }, undefined),
      { wrapper },
    )

    await waitFor(() => {
      expect(result.current.step.step).toBe('held')
    })
  })

  test('tanpa tawaran, tidak ada price check — data tamu diminta lagi', () => {
    api.priceCheck.mockRejectedValue(new Error('jaringan'))
    const { result } = renderHook(() => useBookingFlow(selection, undefined), { wrapper })

    act(() => {
      result.current.submitGuest({ fullName: 'Budi', email: 'budi@example.test' })
    })

    // Tanpa tawaran, data tamu diminta lagi — tidak ada price check tanpa harga yang dilihat.
    expect(result.current.step).toEqual({ step: 'details' })
  })
})

describe('membuka pembayaran', () => {
  test('popup Snap bila tersedia', async () => {
    snap.loadSnap.mockResolvedValue(true)
    snap.openSnap.mockResolvedValue('success')
    window.snap = { pay: vi.fn() }

    expect(await openPayment(PAYMENT, 'b-1')).toBe('success')
    expect(snap.openSnap).toHaveBeenCalledWith('tok-1', window.snap)
    // Dicatat untuk halaman kembalian Snap penuh.
    expect(window.sessionStorage.getItem('tbe:paying')).toBe('b-1')
    delete window.snap
  })

  test('halaman Snap penuh bila popup tidak tersedia', async () => {
    snap.loadSnap.mockResolvedValue(false)
    const assign = vi.fn()
    vi.stubGlobal('location', { assign })

    expect(await openPayment(PAYMENT, 'b-1')).toBe('redirected')
    expect(assign).toHaveBeenCalledWith('https://snap.example/r/1')
    vi.unstubAllGlobals()
  })
})
