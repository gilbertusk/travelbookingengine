import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test } from 'vitest'
import { envelope, fakeFetch, renderWithQuery } from '@/testing/render'
import { ReviewQueue } from './ReviewQueue'
import type { ReviewCase } from './schema'

const BOOKING_ID = '3f0c8a52-6d1e-4c3b-9a7f-0e1d2c3b4a59'
const PAYMENT_ID = 'c2d4e6f8-0a1b-4c3d-8e5f-6a7b8c9d0e1f'

function reviewCase(overrides: Partial<ReviewCase['booking']> = {}): ReviewCase {
  return {
    booking: {
      id: BOOKING_ID,
      status: 'NEEDS_REVIEW',
      supplier: 'SKY',
      propertyId: 'prop-1',
      city: 'Denpasar',
      checkIn: '2026-11-10',
      checkOut: '2026-11-12',
      guests: 2,
      price: { total: { amountMinor: 2_442_000, currency: 'IDR' } },
      supplierRef: null,
      userId: 'u-1',
      version: 5,
      createdAt: '2026-10-25T03:00:00.000Z',
      updatedAt: '2026-10-25T03:10:00.000Z',
      leadGuest: { fullName: 'Sari Wulandari', email: 'sari@example.com' },
      paymentId: PAYMENT_ID,
      review: { from: 'PAID', reason: 'supplier_uncertain:timeout' },
      failureReason: null,
      refundId: null,
      ...overrides,
    },
    supplierIdempotencyKey: BOOKING_ID,
    saga: {
      phase: 'review',
      step: 'supplier_confirm',
      attempts: 3,
      lastError: 'timeout',
      compensation: 'skipped',
      updatedAt: '2026-10-25T03:10:00.000Z',
    },
    trail: [
      { sequence: 1, type: 'BookingCreated', occurredAt: '2026-10-25T03:00:00.000Z', payload: {} },
      { sequence: 5, type: 'ReviewRequired', occurredAt: '2026-10-25T03:10:00.000Z', payload: {} },
    ],
  }
}

function setup(cases: readonly ReviewCase[]) {
  return fakeFetch({
    'GET /api/ops/bookings/review': envelope(cases),
    [`GET /api/ops/payments/${PAYMENT_ID}`]: envelope({
      payment: {
        id: PAYMENT_ID,
        status: 'SUCCEEDED',
        amount: { amountMinor: 2_442_000, currency: 'IDR' },
        refunds: [{ status: 'PENDING', amount: { amountMinor: 1_000, currency: 'IDR' } }],
      },
    }),
    'GET /api/ops/suppliers/requests': envelope([
      {
        id: 'r-1',
        supplier: 'SKY',
        operation: 'book',
        outcome: 'failure',
        errorKind: 'timeout',
        attemptNumber: 1,
        latencyMs: 5_000,
        requestPayload: null,
        responsePayload: null,
        createdAt: '2026-10-25T03:05:00.000Z',
      },
    ]),
  })
}

describe('ReviewQueue', () => {
  test('antrean kosong dinyatakan, bukan tabel kosong', async () => {
    setup([])
    renderWithQuery(<ReviewQueue />)

    expect(await screen.findByText(/Tidak ada pemesanan/)).toBeInTheDocument()
  })

  test('konteks lengkap: kekhawatiran, saga, jejak, pembayaran, dan permintaan supplier', async () => {
    const { calls } = setup([reviewCase()])
    const user = userEvent.setup()
    renderWithQuery(<ReviewQueue />)

    await user.click(await screen.findByRole('button', { name: 'Lihat konteks' }))

    expect(screen.getByText(/Kamar belum pasti/)).toBeInTheDocument()
    expect(
      screen.getByText(/review di langkah supplier_confirm, 3 percobaan, galat terakhir: timeout/),
    ).toBeInTheDocument()
    expect(screen.getByText('ReviewRequired')).toBeInTheDocument()
    expect(await screen.findByText('SUCCEEDED')).toBeInTheDocument()
    expect(screen.getByText(/refund PENDING/)).toBeInTheDocument()
    expect(await screen.findByText(/gagal \(timeout\)/)).toBeInTheDocument()
    expect(calls.map((call) => call.url)).toContain(
      `/api/ops/suppliers/requests?idempotencyKey=${BOOKING_ID}`,
    )
  })

  test('tanpa pembayaran dan tanpa saga: ditulis "—", tidak memanggil payment-service', async () => {
    const early = {
      ...reviewCase({ paymentId: null, review: null, failureReason: 'sold_out' }),
      saga: null,
    }
    const { calls } = setup([early])
    const user = userEvent.setup()
    renderWithQuery(<ReviewQueue />)

    await user.click(await screen.findByRole('button', { name: 'Lihat konteks' }))

    expect(screen.getByText('Pembayaran: —')).toBeInTheDocument()
    expect(screen.getByText('Saga: —')).toBeInTheDocument()
    expect(screen.getByText('Alasan: sold_out')).toBeInTheDocument()
    expect(calls.some((call) => call.url.startsWith('/api/ops/payments'))).toBe(false)
  })

  test('galat antrean ditampilkan', async () => {
    fakeFetch({
      'GET /api/ops/bookings/review': { status: 500, body: { error: { message: 'mati' } } },
    })
    renderWithQuery(<ReviewQueue />)

    expect(await screen.findByText('mati')).toBeInTheDocument()
  })
})
