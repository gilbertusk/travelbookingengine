import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { CityAutocomplete } from './city-autocomplete'
import { renderWithQuery } from '@/testing/render'

/**
 * Saran kota (FR-08).
 *
 * Seluruh berkas ini tentang papan ketik. Daftar saran yang hanya dapat
 * diklik adalah daftar saran yang tidak ada bagi sebagian pengguna, dan
 * DESIGN-SYSTEM.md bagian 11 mewajibkan seluruh alur dapat dioperasikan
 * dengan papan ketik.
 */

const SUGGESTIONS = {
  cities: [
    { city: 'Bali', countryCode: 'ID', propertyCount: 40 },
    { city: 'Bandung', countryCode: 'ID', propertyCount: 40 },
  ],
  properties: [
    {
      slug: 'padma-bali',
      name: 'Padma Bali Boutique Hotel',
      city: 'Bali',
      countryCode: 'ID',
      starRating: 4,
    },
  ],
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify({ data: SUGGESTIONS, error: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function Harness({ initial = 'bal' }: { readonly initial?: string }) {
  return <CityAutocomplete value={initial} onChange={vi.fn()} />
}

function optionAt(index: number): HTMLElement {
  const option = screen.getAllByRole('option')[index]
  if (option === undefined) throw new Error(`tidak ada pilihan ke-${String(index)}`)

  return option
}

async function openList(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('combobox'))
  await waitFor(() => {
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0)
  })
}

describe('pola combobox', () => {
  test('masukannya berperan combobox dengan daftar yang tertaut', async () => {
    renderWithQuery(<Harness />)
    const user = userEvent.setup()

    const input = screen.getByRole('combobox')
    expect(input).toHaveAttribute('aria-expanded', 'false')

    await openList(user)

    expect(input).toHaveAttribute('aria-expanded', 'true')
    expect(input).toHaveAttribute('aria-controls', screen.getByRole('listbox').id)
  })

  test('kota lebih dulu, lalu properti', async () => {
    // Yang dicari di kotak ini hampir selalu tujuan, bukan hotel tertentu.
    renderWithQuery(<Harness />)
    await openList(userEvent.setup())

    const options = screen.getAllByRole('option').map((item) => item.textContent)

    expect(options[0]).toContain('Bali')
    expect(options[2]).toContain('Padma Bali Boutique Hotel')
  })
})

describe('papan ketik', () => {
  test('panah bawah memindahkan sorotan', async () => {
    renderWithQuery(<Harness />)
    const user = userEvent.setup()
    await openList(user)

    await user.keyboard('{ArrowDown}')

    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true')
  })

  test('sorotan berputar di ujung daftar', async () => {
    renderWithQuery(<Harness />)
    const user = userEvent.setup()
    await openList(user)

    await user.keyboard('{ArrowUp}')

    const options = screen.getAllByRole('option')
    expect(options.at(-1)).toHaveAttribute('aria-selected', 'true')
  })

  test('elemen yang tersorot diumumkan lewat aria-activedescendant', async () => {
    renderWithQuery(<Harness />)
    const user = userEvent.setup()
    await openList(user)

    await user.keyboard('{ArrowDown}')

    const input = screen.getByRole('combobox')
    expect(input.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[0]?.id)
  })

  test('Enter memilih yang tersorot', async () => {
    const onChange = vi.fn()
    renderWithQuery(<CityAutocomplete value="bal" onChange={onChange} />)
    const user = userEvent.setup()
    await openList(user)

    await user.keyboard('{ArrowDown}{Enter}')

    expect(onChange).toHaveBeenCalledWith('Bali')
  })

  test('Enter TANPA sorotan tidak memilih apa pun', async () => {
    // Pengguna yang mengetik "Bali" lalu menekan Enter bermaksud mencari
    // "Bali" — bukan "Balikpapan" yang kebetulan di puncak daftar.
    const onChange = vi.fn()
    renderWithQuery(<CityAutocomplete value="bal" onChange={onChange} />)
    const user = userEvent.setup()
    await openList(user)

    await user.keyboard('{Enter}')

    expect(onChange).not.toHaveBeenCalled()
  })

  test('Escape menutup tanpa mengubah apa pun', async () => {
    const onChange = vi.fn()
    renderWithQuery(<CityAutocomplete value="bal" onChange={onChange} />)
    const user = userEvent.setup()
    await openList(user)

    await user.keyboard('{Escape}')

    expect(screen.getByRole('combobox')).toHaveAttribute('aria-expanded', 'false')
    expect(onChange).not.toHaveBeenCalled()
  })

  test('panah bawah membuka daftar yang tertutup', async () => {
    renderWithQuery(<Harness />)
    const user = userEvent.setup()
    await openList(user)
    await user.keyboard('{Escape}')

    await user.keyboard('{ArrowDown}')

    expect(screen.getByRole('combobox')).toHaveAttribute('aria-expanded', 'true')
  })
})

describe('memilih dengan tetikus', () => {
  test('mengklik saran mengisi kotanya', async () => {
    const onChange = vi.fn()
    renderWithQuery(<CityAutocomplete value="bal" onChange={onChange} />)
    const user = userEvent.setup()
    await openList(user)

    await user.click(optionAt(1))

    expect(onChange).toHaveBeenCalledWith('Bandung')
  })

  test('memilih saran properti mengisi KOTANYA, bukan melompat ke hotelnya', async () => {
    // Alur pencariannya tetap satu jalur: kota lalu tanggal lalu hasil.
    const onChange = vi.fn()
    renderWithQuery(<CityAutocomplete value="bal" onChange={onChange} />)
    const user = userEvent.setup()
    await openList(user)

    await user.click(optionAt(2))

    expect(onChange).toHaveBeenCalledWith('Bali')
  })
})

describe('kueri pendek', () => {
  test('tidak menembak jaringan', async () => {
    // Satu atau dua huruf cocok dengan hampir seluruh katalog, jadi
    // jawabannya tidak membantu siapa pun sementara kuerinya paling mahal.
    renderWithQuery(<CityAutocomplete value="b" onChange={vi.fn()} />)

    await new Promise((resolve) => setTimeout(resolve, 400))

    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })
})
