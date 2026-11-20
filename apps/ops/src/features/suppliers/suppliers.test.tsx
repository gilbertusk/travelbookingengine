import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test } from 'vitest'
import { envelope, fakeFetch, renderWithQuery } from '@/testing/render'
import { SupplierHealthTable } from './SupplierHealthTable'
import { SupplierSettingsForm } from './SupplierSettingsForm'
import type { SupplierHealth } from './schema'

function supplier(overrides: Partial<SupplierHealth> = {}): SupplierHealth {
  return {
    code: 'SKY',
    name: 'Sky',
    isActive: true,
    settings: { circuit: { failureThreshold: 5, windowMs: 60_000, openDurationMs: 30_000 } },
    circuits: {
      search: 'closed',
      priceCheck: 'closed',
      hold: 'closed',
      book: 'open',
      cancel: 'half_open',
    },
    window: {
      attempts: 40,
      failures: 10,
      errorRateBasisPoints: 2_500,
      latencyP50Ms: 120,
      latencyP95Ms: 900,
      windowMs: 900_000,
      isTruncated: false,
    },
    ...overrides,
  }
}

describe('SupplierHealthTable', () => {
  test('pemutus per operasi dengan kata, bukan hanya warna; statistik jendela', async () => {
    fakeFetch({ 'GET /api/ops/suppliers': envelope([supplier()]) })

    renderWithQuery(<SupplierHealthTable />)

    const row = (await screen.findByText('SKY')).closest('tr')
    if (row === null) throw new Error('baris tidak ada')
    expect(within(row).getByText('TERBUKA')).toBeInTheDocument()
    expect(within(row).getByText('setengah')).toBeInTheDocument()
    expect(within(row).getAllByText('tertutup')).toHaveLength(3)
    expect(within(row).getByText('25%')).toBeInTheDocument()
    expect(within(row).getByText('900 ms')).toBeInTheDocument()
  })

  test('supplier nonaktif ditandai; tanpa percobaan, galat "—" bukan 0%; sampel terpotong diberi catatan', async () => {
    const idle = supplier({
      isActive: false,
      window: { ...supplier().window, attempts: 0, errorRateBasisPoints: 0, isTruncated: true },
    })
    fakeFetch({ 'GET /api/ops/suppliers': envelope([idle]) })

    renderWithQuery(<SupplierHealthTable />)

    expect(await screen.findByText('nonaktif')).toBeInTheDocument()
    expect(screen.getByText(/Batas sampel tercapai/)).toBeInTheDocument()
    expect(screen.queryByText('0%')).not.toBeInTheDocument()
  })

  test('galat service ditampilkan, bukan tabel kosong', async () => {
    fakeFetch({
      'GET /api/ops/suppliers': { status: 503, body: { error: { code: 'X', message: 'mati' } } },
    })

    renderWithQuery(<SupplierHealthTable />)

    expect(await screen.findByText(/tidak dapat dibaca: mati/)).toBeInTheDocument()
  })
})

describe('SupplierSettingsForm', () => {
  test('menonaktifkan dan mengubah ambang mengirim PATCH ke supplier yang benar', async () => {
    const { calls } = fakeFetch({
      'GET /api/ops/suppliers': envelope([supplier()]),
      'PATCH /api/ops/suppliers/SKY': envelope({}),
    })
    const user = userEvent.setup()
    renderWithQuery(<SupplierSettingsForm />)

    await user.click(await screen.findByRole('button', { name: 'Nonaktifkan' }))
    const threshold = screen.getByLabelText('Ambang kegagalan pemutus')
    await user.clear(threshold)
    await user.type(threshold, '3')
    await user.click(screen.getByRole('button', { name: 'Simpan ambang' }))

    await waitFor(() => {
      expect(calls.filter((call) => call.method === 'PATCH').map((call) => call.body)).toEqual([
        { isActive: false },
        { circuit: { failureThreshold: 3 } },
      ])
    })
  })

  test('ambang bukan bilangan positif tidak dapat disimpan', async () => {
    fakeFetch({ 'GET /api/ops/suppliers': envelope([supplier({ isActive: false })]) })
    const user = userEvent.setup()
    renderWithQuery(<SupplierSettingsForm />)

    expect(await screen.findByRole('button', { name: 'Aktifkan' })).toBeInTheDocument()
    const threshold = screen.getByLabelText('Ambang kegagalan pemutus')
    await user.clear(threshold)
    await user.type(threshold, '0')

    expect(screen.getByRole('button', { name: 'Simpan ambang' })).toBeDisabled()
  })

  test('galat pembacaan ditampilkan', async () => {
    fakeFetch({ 'GET /api/ops/suppliers': { status: 500, body: { error: { message: 'rusak' } } } })

    renderWithQuery(<SupplierSettingsForm />)

    expect(await screen.findByText('rusak')).toBeInTheDocument()
  })
})
