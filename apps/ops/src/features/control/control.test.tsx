import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test } from 'vitest'
import { fakeFetch, renderWithQuery } from '@/testing/render'
import { MockSupplierControl } from './MockSupplierControl'

const STATE = {
  suppliers: [
    { code: 'SKY', chaos: { down: false, failureMode: 'server_error' } },
    {
      code: 'NOVA',
      chaos: { down: true, failureMode: 'timeout', failureRate: 0.25, latencyMs: [100, 300] },
    },
  ],
}

function setup() {
  return fakeFetch({
    'GET /api/ops/mock-supplier/state': { body: STATE },
    'POST /api/ops/mock-supplier/sky/down': { body: {} },
    'POST /api/ops/mock-supplier/nova/up': { body: {} },
    'POST /api/ops/mock-supplier/sky/failure': { body: {} },
    'POST /api/ops/mock-supplier/sky/latency': { body: {} },
    'POST /api/ops/mock-supplier/reset': { body: {} },
  })
}

describe('MockSupplierControl', () => {
  test('keadaan tiap supplier dibaca dari jawaban mentah mock supplier', async () => {
    setup()
    renderWithQuery(<MockSupplierControl />)

    expect(await screen.findByText('MATI')).toBeInTheDocument()
    expect(screen.getByText(/gagal 25% · timeout/)).toBeInTheDocument()
    expect(screen.getByText(/latensi 100–300 ms/)).toBeInTheDocument()
  })

  test('mematikan SKY dan menyalakan NOVA memanggil rute yang benar', async () => {
    const { calls } = setup()
    const user = userEvent.setup()
    renderWithQuery(<MockSupplierControl />)

    await user.click(await screen.findByRole('button', { name: 'Matikan' }))
    await user.click(screen.getByRole('button', { name: 'Nyalakan' }))
    await user.click(screen.getByRole('button', { name: 'Pulihkan semua supplier' }))

    await waitFor(() => {
      expect(calls.filter((call) => call.method === 'POST').map((call) => call.url)).toEqual([
        '/api/ops/mock-supplier/sky/down',
        '/api/ops/mock-supplier/nova/up',
        '/api/ops/mock-supplier/reset',
      ])
    })
  })

  test('kegagalan dan latensi dikirim dalam satuan mock supplier (pecahan, milidetik)', async () => {
    const { calls } = setup()
    const user = userEvent.setup()
    renderWithQuery(<MockSupplierControl />)

    const [rate] = await screen.findAllByLabelText('Kegagalan (%)')
    if (rate === undefined) throw new Error('tidak ada isian')
    await user.clear(rate)
    await user.type(rate, '30')
    const [mode] = screen.getAllByLabelText('Mode')
    if (mode === undefined) throw new Error('tidak ada pilihan mode')
    await user.selectOptions(mode, 'timeout')
    const [inject] = screen.getAllByRole('button', { name: 'Suntik kegagalan' })
    if (inject === undefined) throw new Error('tidak ada tombol')
    await user.click(inject)
    const [latency] = screen.getAllByRole('button', { name: 'Suntik latensi' })
    if (latency === undefined) throw new Error('tidak ada tombol')
    await user.click(latency)

    await waitFor(() => {
      expect(calls.filter((call) => call.method === 'POST').map((call) => call.body)).toEqual([
        { rate: 0.3, mode: 'timeout' },
        { min: 2_000, max: 2_000 },
      ])
    })
  })

  test('kegagalan di luar 0–100% tidak dapat dikirim', async () => {
    setup()
    const user = userEvent.setup()
    renderWithQuery(<MockSupplierControl />)

    const [rate] = await screen.findAllByLabelText('Kegagalan (%)')
    if (rate === undefined) throw new Error('tidak ada isian')
    await user.clear(rate)
    await user.type(rate, '150')

    expect(screen.getAllByRole('button', { name: 'Suntik kegagalan' })[0]).toBeDisabled()
  })

  test('mock supplier tidak dapat dihubungi', async () => {
    fakeFetch({ 'GET /api/ops/mock-supplier/state': { status: 503, body: { error: 'x' } } })
    renderWithQuery(<MockSupplierControl />)

    expect(await screen.findByText(/tidak dapat dihubungi/)).toBeInTheDocument()
  })
})
