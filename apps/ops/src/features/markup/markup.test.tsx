import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test } from 'vitest'
import { envelope, fakeFetch, renderWithQuery } from '@/testing/render'
import { MarkupRuleForm } from './MarkupRuleForm'
import { MarkupRuleList } from './MarkupRuleList'
import { ruleBodyOf, samplesFor, type Preview } from './schema'

const RULES = [
  {
    id: 'r-1',
    name: 'Global',
    priority: 0,
    scope: {},
    kind: 'percentage',
    percentageBasisPoints: 1_000,
    isActive: true,
  },
  {
    id: 'r-2',
    name: 'SKY tetap',
    priority: 1,
    scope: { supplier: 'SKY', city: 'Bali' },
    kind: 'fixed',
    fixedAmount: { amountMinor: 50_000, currency: 'IDR' },
    isActive: false,
  },
]

const idr = (amountMinor: number) => ({ amountMinor, currency: 'IDR' })
const PREVIEW: Preview = {
  rows: [
    {
      ref: 'SKY',
      before: { ok: true, total: idr(1_221_000), markup: idr(100_000), ruleId: 'r-1' },
      after: { ok: true, total: idr(1_332_000), markup: idr(200_000), ruleId: 'pratinjau' },
      isChanged: true,
    },
    {
      ref: 'NOVA',
      before: { ok: false, error: { kind: 'missing_exchange_rate' } },
      after: { ok: false, error: { kind: 'missing_exchange_rate' } },
      isChanged: false,
    },
  ],
  changedCount: 1,
  isTieBreakUncertain: true,
}

describe('MarkupRuleList', () => {
  test('aturan aktif dinonaktifkan (DELETE), yang nonaktif diaktifkan (PATCH)', async () => {
    const { calls } = fakeFetch({
      'GET /api/ops/pricing/markup-rules': envelope(RULES),
      'DELETE /api/ops/pricing/markup-rules/r-1': envelope({}),
      'PATCH /api/ops/pricing/markup-rules/r-2': envelope({}),
    })
    const user = userEvent.setup()
    renderWithQuery(<MarkupRuleList />)

    expect(await screen.findByText('global')).toBeInTheDocument()
    expect(screen.getByText('SKY · Bali')).toBeInTheDocument()
    expect(screen.getByText('10%')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Nonaktifkan' }))
    await user.click(screen.getByRole('button', { name: 'Aktifkan' }))

    await waitFor(() => {
      expect(
        calls.filter((call) => call.method !== 'GET').map((call) => [call.method, call.body]),
      ).toEqual([
        ['DELETE', undefined],
        ['PATCH', { isActive: true }],
      ])
    })
  })

  test('kosong dan galat', async () => {
    fakeFetch({ 'GET /api/ops/pricing/markup-rules': envelope([]) })
    renderWithQuery(<MarkupRuleList />)
    expect(await screen.findByText('Belum ada aturan.')).toBeInTheDocument()
  })
})

describe('MarkupRuleForm', () => {
  test('simpan baru aktif setelah pratinjau; pratinjau menunjukkan dampak dan peringatan seri', async () => {
    const { calls } = fakeFetch({
      'POST /api/ops/pricing/markup-rules/preview': envelope(PREVIEW),
      'POST /api/ops/pricing/markup-rules': envelope({ id: 'baru' }),
      'GET /api/ops/pricing/markup-rules': envelope([]),
    })
    const user = userEvent.setup()
    renderWithQuery(<MarkupRuleForm />)

    await user.type(screen.getByLabelText('Nama'), 'Bali 20')
    await user.type(screen.getByLabelText('Markup (%)'), '20')
    await user.type(screen.getByLabelText('Kota (kosong = semua)'), 'Bali')
    expect(screen.getByRole('button', { name: 'Simpan aturan' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Pratinjau dampak' }))

    expect(await screen.findByText('1 dari 2 sampel berubah harga.')).toBeInTheDocument()
    expect(screen.getByText(/seri dengan aturan aktif lain/)).toBeInTheDocument()
    expect(screen.getAllByText('gagal (missing_exchange_rate)')).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: 'Simpan aturan' }))

    await waitFor(() => {
      expect(
        calls.find((call) => call.url === '/api/ops/pricing/markup-rules' && call.method === 'POST')
          ?.body,
      ).toEqual({
        name: 'Bali 20',
        priority: 0,
        kind: 'percentage',
        percentageBasisPoints: 2_000,
        scope: { city: 'Bali' },
      })
    })
  })

  test('mengubah isian membatalkan pratinjau — yang disimpan selalu yang dipratinjau', async () => {
    fakeFetch({ 'POST /api/ops/pricing/markup-rules/preview': envelope(PREVIEW) })
    const user = userEvent.setup()
    renderWithQuery(<MarkupRuleForm />)

    await user.type(screen.getByLabelText('Nama'), 'X')
    await user.type(screen.getByLabelText('Markup (%)'), '5')
    await user.click(screen.getByRole('button', { name: 'Pratinjau dampak' }))
    await screen.findByText(/sampel berubah harga/)
    await user.type(screen.getByLabelText('Markup (%)'), '0')

    expect(screen.getByRole('button', { name: 'Simpan aturan' })).toBeDisabled()
  })
})

describe('ruleBodyOf dan samplesFor', () => {
  test('persen manusia → basis poin; draf tidak lengkap ditolak', () => {
    const draft = { name: ' A ', priority: 2, city: '', supplier: 'NOVA', percent: '12,5' }

    expect(ruleBodyOf(draft)).toEqual({
      name: 'A',
      priority: 2,
      kind: 'percentage',
      percentageBasisPoints: 1_250,
      scope: { supplier: 'NOVA' },
    })
    expect(ruleBodyOf({ ...draft, name: ' ' })).toBeUndefined()
    expect(ruleBodyOf({ ...draft, percent: 'abc' })).toBeUndefined()
    expect(ruleBodyOf({ ...draft, percent: '-1' })).toBeUndefined()
  })

  test('satu sampel per supplier', () => {
    expect(samplesFor('Bali', 1_000).map((sample) => sample.supplier)).toEqual([
      'SKY',
      'NOVA',
      'ORBIT',
      'LUNA',
      'ZEPH',
    ])
  })
})
