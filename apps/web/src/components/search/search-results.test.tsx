import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { SearchResults } from './search-results'
import { renderWithQuery } from '@/testing/render'
import type { SearchResponse } from '@/features/search/types'

/**
 * Halaman hasil.
 *
 * Lima keadaan, seluruhnya wajib — DESIGN-SYSTEM.md bagian 7. Yang dijaga di
 * sini adalah bahwa kelimanya benar-benar ada DAN bahwa yang satu tidak
 * menggantikan yang lain: keadaan galat yang muncul padahal data lama masih
 * ada akan menghapus hasil yang sedang dibaca pengguna.
 */

const replace = vi.fn()
let query = 'kota=Bali&mulai=2026-11-10&selesai=2026-11-12'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace, refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(query),
}))

function money(amountMinor: number) {
  return { amountMinor, currency: 'IDR' as const }
}

function response(overrides: Partial<SearchResponse> = {}): SearchResponse {
  return {
    properties: [
      {
        ref: 'prop-padma',
        mapped: true,
        slug: 'padma-bali-boutique-hotel',
        name: 'Padma Bali Boutique Hotel',
        city: 'Bali',
        starRating: 4,
        amenities: ['pool'],
        suppliers: ['SKY'],
        lowestTotal: money(1_332_000),
        offers: [
          {
            supplier: 'SKY',
            supplierPropertyId: 'sky-1',
            supplierRatePlanId: 'rp-1',
            roomTypeName: 'Deluxe',
            ratePlanName: 'Refundable',
            refundable: true,
            breakfastIncluded: true,
            unitsLeft: 5,
            total: money(1_332_000),
            base: money(1_000_000),
            markup: money(200_000),
            tax: money(132_000),
            taxName: 'PPN',
          },
        ],
      },
    ],
    meta: {
      source: 'live',
      suppliersResponded: ['SKY', 'NOVA'],
      suppliersTimedOut: ['LUNA'],
      suppliersUnavailable: [],
      latencyMs: 900,
      partial: true,
    },
    ...overrides,
  }
}

function stubFetch(handler: () => Response | Promise<Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => await handler()),
  )
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify({ data: body, error: null }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  replace.mockReset()
  query = 'kota=Bali&mulai=2026-11-10&selesai=2026-11-12'
  stubFetch(() => ok(response()))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('keadaan: belum mencari', () => {
  test('kriteria yang tidak lengkap menampilkan formulir, bukan daftar kosong', async () => {
    // Dua keadaan yang tampak sama kalau tidak dibedakan: "belum mencari
    // apa pun" butuh formulir, "mencari dan tidak menemukan" butuh saran
    // mengubah kriteria.
    query = 'kota=Bali'
    renderWithQuery(<SearchResults />)

    expect(await screen.findByText('Mau menginap di mana?')).toBeInTheDocument()
    expect(screen.queryByText(/Tidak ada yang cocok/)).not.toBeInTheDocument()
  })
})

describe('keadaan: memuat', () => {
  test('skeleton, bukan spinner, dan diumumkan sebagai sedang sibuk', () => {
    stubFetch(() => new Promise<Response>(() => undefined))
    const view = renderWithQuery(<SearchResults />)

    expect(view.container.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(screen.getByText('Mencari hotel')).toBeInTheDocument()
  })
})

describe('keadaan: berisi dan parsial', () => {
  test('hasil ditampilkan beserta keterangan penyedia yang belum menjawab', async () => {
    renderWithQuery(<SearchResults />)

    expect(await screen.findByText('Padma Bali Boutique Hotel')).toBeInTheDocument()
    expect(screen.getByText(/2 dari 3 penyedia/)).toBeInTheDocument()
  })

  test('jumlah pilihan disebutkan', async () => {
    renderWithQuery(<SearchResults />)

    expect(await screen.findByText('1 pilihan')).toBeInTheDocument()
  })

  test('judulnya menyebut kota yang dicari', async () => {
    renderWithQuery(<SearchResults />)

    expect(await screen.findByRole('heading', { name: /Hotel di Bali/ })).toBeInTheDocument()
  })
})

describe('keadaan: kosong', () => {
  test('penjelasan dan saran mengubah kriteria', async () => {
    stubFetch(() => ok(response({ properties: [] })))
    renderWithQuery(<SearchResults />)

    expect(await screen.findByText('Tidak ada yang cocok')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Hapus semua penyaring/ })).toBeInTheDocument()
  })

  test('tombolnya benar-benar melonggarkan penyaring', async () => {
    query = `${query}&bintang=5&refundable=1`
    stubFetch(() => ok(response({ properties: [] })))
    renderWithQuery(<SearchResults />)

    await userEvent.click(await screen.findByRole('button', { name: /Hapus semua penyaring/ }))

    const target = replace.mock.calls[0]?.[0] as string
    expect(target).not.toContain('bintang=')
    expect(target).not.toContain('refundable=')
  })
})

describe('keadaan: galat', () => {
  test('penjelasan manusiawi dan tombol coba lagi', async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ data: null, error: { code: 'X', message: 'gagal' } }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
    )
    renderWithQuery(<SearchResults />)

    expect(await screen.findByText('Pencarian gagal')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Coba lagi' })).toBeInTheDocument()
  })
})

describe('penyaring memperbarui URL', () => {
  test('mengubah urutan menulis ke URL, bukan ke state lokal', async () => {
    // Penyaring yang hanya hidup di memori hilang saat halaman dimuat ulang,
    // dan tautan yang dibagikan menunjukkan hasil yang berbeda.
    renderWithQuery(<SearchResults />)
    await screen.findByText('Padma Bali Boutique Hotel')

    await userEvent.click(screen.getByLabelText('Bisa dibatalkan'))

    await waitFor(() => {
      expect(replace).toHaveBeenCalled()
    })
    expect(replace.mock.calls[0]?.[0]).toContain('refundable=1')
  })

  test('memakai replace, bukan push', async () => {
    // Mengubah penyaring lima kali lalu menekan tombol kembali seharusnya
    // mengembalikan pengguna ke halaman sebelumnya, bukan menelusuri lima
    // keadaan penyaring satu per satu.
    renderWithQuery(<SearchResults />)
    await screen.findByText('Padma Bali Boutique Hotel')

    await userEvent.click(screen.getByLabelText('Bisa dibatalkan'))

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith(expect.any(String), { scroll: false })
    })
  })

  test('chip penyaring aktif muncul dari URL', async () => {
    query = `${query}&bintang=4`
    renderWithQuery(<SearchResults />)
    await screen.findByText('Padma Bali Boutique Hotel')

    // Dua kendali bernama sama dan itu disengaja: satu di panel penyaring
    // (tombol dua keadaan), satu sebagai chip yang dapat dilepas. Keduanya
    // diturunkan dari kriteria yang sama, jadi mustahil saling bertentangan.
    expect(screen.getAllByRole('button', { name: /4 bintang ke atas/ })).toHaveLength(2)
  })
})
