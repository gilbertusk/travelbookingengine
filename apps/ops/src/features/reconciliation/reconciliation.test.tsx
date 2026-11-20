import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test } from 'vitest'
import { fakeFetch, renderWithQuery } from '@/testing/render'
import { ReconciliationReport } from './ReconciliationReport'

const FINISHED = {
  id: '0b5e7a5e-1c2d-4e3f-8a9b-0c1d2e3f4a5b',
  day: '2026-10-01',
  supplier: null,
  startedAt: '2026-10-01T06:00:00.000Z',
  finishedAt: '2026-10-01T06:00:09.000Z',
  checked: 4,
  matched: 2,
  mismatched: 1,
  unverified: 1,
  flagged: 1,
  findings: [
    {
      bookingId: '3f0c8a52-6d1e-4c3b-9a7f-000000000001',
      supplier: 'SKY',
      localStatus: 'REFUNDED',
      kind: 'active_at_supplier',
      detail: 'rekonsiliasi: REFUNDED di sini, masih AKTIF di supplier SKY (kunci x)',
      flagged: true,
      recordedAt: '2026-10-01T06:00:05.000Z',
    },
    {
      bookingId: '3f0c8a52-6d1e-4c3b-9a7f-000000000002',
      supplier: 'NOVA',
      localStatus: 'CONFIRMED',
      kind: 'unverified',
      detail: 'supplier tidak dapat ditanya',
      flagged: false,
      recordedAt: '2026-10-01T06:00:07.000Z',
    },
  ],
}

function setup(runs: unknown[] = [FINISHED]) {
  return fakeFetch({
    'GET /api/ops/bookings/reconciliation': { body: { data: runs, error: null } },
    'POST /api/ops/bookings/reconciliation/run': {
      status: 202,
      body: { data: { runId: '9c1b2a3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d' }, error: null },
    },
  })
}

describe('ReconciliationReport', () => {
  test('putaran dengan hitungannya, dan setiap temuan dengan jenis dan akibatnya', async () => {
    setup()
    renderWithQuery(<ReconciliationReport />)

    expect(await screen.findByText('1 ditandai untuk tinjauan')).toBeInTheDocument()
    expect(
      screen.getByText(/Diperiksa 4 · cocok 2 · tidak cocok 1 · tidak dapat diperiksa 1/),
    ).toBeInTheDocument()
    expect(screen.getByText('Masih aktif di supplier')).toBeInTheDocument()
    expect(screen.getByText('Ditandai')).toBeInTheDocument()
    // Yang tidak dapat diperiksa BUKAN ketidaksesuaian, dan tidak ditandai.
    expect(screen.getByText('Supplier tidak dapat ditanya')).toBeInTheDocument()
    expect(screen.getByText('Diperiksa lagi putaran berikutnya')).toBeInTheDocument()
  })

  test('putaran yang belum selesai tidak dilaporkan sebagai cocok', async () => {
    setup([{ ...FINISHED, finishedAt: null, flagged: 0, findings: [] }])
    renderWithQuery(<ReconciliationReport />)

    expect(await screen.findByText('Berjalan atau terhenti')).toBeInTheDocument()
    expect(screen.queryByText('Cocok')).not.toBeInTheDocument()
  })

  test('tanpa putaran sama sekali', async () => {
    setup([])
    renderWithQuery(<ReconciliationReport />)

    expect(await screen.findByText('Belum ada putaran rekonsiliasi.')).toBeInTheDocument()
  })

  test('operator meminta putaran baru — satu-satunya tindakan di halaman ini', async () => {
    const { calls } = setup()
    const user = userEvent.setup()
    renderWithQuery(<ReconciliationReport />)

    await user.click(await screen.findByRole('button', { name: 'Jalankan rekonsiliasi sekarang' }))

    expect(await screen.findByRole('status')).toHaveTextContent('9c1b2a3d')
    await waitFor(() => {
      expect(calls.filter((call) => call.method === 'POST').map((call) => call.url)).toEqual([
        '/api/ops/bookings/reconciliation/run',
      ])
    })
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })
})
