import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test } from 'vitest'
import { envelope, fakeFetch, renderWithQuery } from '@/testing/render'
import { AnalyticsReport } from './AnalyticsReport'
import type { AnalyticsReport as Report } from './schema'

const REPORT: Report = {
  range: { from: '2026-09-26', to: '2026-10-25' },
  summary: {
    funnel: [
      { stage: 'search', count: 1_000, fromPreviousBasisPoints: null },
      { stage: 'booking_created', count: 100, fromPreviousBasisPoints: 1_000 },
      { stage: 'held', count: 50, fromPreviousBasisPoints: 5_000 },
      { stage: 'paid', count: 40, fromPreviousBasisPoints: 8_000 },
      { stage: 'confirmed', count: 38, fromPreviousBasisPoints: 9_500 },
    ],
    search: { count: 1_000, averageLatencyMs: 640, averageResults: 24 },
    suppliers: [
      {
        supplier: 'SKY',
        searchesAsked: 10,
        responseRateBasisPoints: 8_000,
        bookingsCreated: 4,
        priceChangeRateBasisPoints: 2_500,
        bookingsConfirmed: 3,
        bookingsFailed: 1,
        confirmUncertain: 0,
        degradedTimes: 2,
      },
    ],
    topCities: [{ city: 'bali', searches: 600 }],
    topStays: [{ city: 'bali', checkIn: '2026-11-10', checkOut: '2026-11-12', searches: 40 }],
    failures: {
      bookingsCreated: 100,
      bookingsFailed: 5,
      failureRateBasisPoints: 500,
      byCause: [{ stage: 'supplier_confirm', reason: 'sold_out', count: 5 }],
    },
  },
}

describe('AnalyticsReport', () => {
  test('corong, kegagalan, supplier, dan kota terpopuler', async () => {
    fakeFetch({ 'GET /api/ops/analytics/summary': envelope(REPORT) })
    renderWithQuery(<AnalyticsReport />)

    expect(await screen.findByText('Terkonfirmasi')).toBeInTheDocument()
    expect(screen.getByText(/95% dari tahap sebelumnya/)).toBeInTheDocument()
    expect(screen.getByText('640 ms')).toBeInTheDocument()
    expect(screen.getByText(/5% \(5\s+dari 100\)/)).toBeInTheDocument()
    expect(screen.getByText('supplier_confirm: sold_out')).toBeInTheDocument()
    expect(screen.getByText(/terdegradasi 2×/)).toBeInTheDocument()
    expect(screen.getByText('bali 2026-11-10 → 2026-11-12')).toBeInTheDocument()
  })

  test('rentang yang diisi diteruskan sebagai kueri', async () => {
    const { calls } = fakeFetch({ 'GET /api/ops/analytics/summary': envelope(REPORT) })
    const user = userEvent.setup()
    renderWithQuery(<AnalyticsReport />)

    await screen.findByText('Terkonfirmasi')
    await user.type(screen.getByLabelText('Dari'), '2026-10-01')

    await waitFor(() => {
      expect(calls.at(-1)?.url).toBe('/api/ops/analytics/summary?from=2026-10-01')
    })
  })

  test('galat analitik ditampilkan', async () => {
    fakeFetch({
      'GET /api/ops/analytics/summary': { status: 400, body: { error: { message: 'rentang' } } },
    })
    renderWithQuery(<AnalyticsReport />)

    expect(await screen.findByText('rentang')).toBeInTheDocument()
  })
})
