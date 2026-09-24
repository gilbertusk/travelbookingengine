import { render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { PartialResultNotice } from './partial-result-notice'
import type { SearchMeta } from '@/features/search/types'

/**
 * Keadaan kelima.
 *
 * DESIGN-SYSTEM.md bagian 7 menyebutnya keadaan yang PERTAMA KALI dilihat
 * pengguna. Yang dijaga di sini: ia menyebut angka, ia diumumkan pembaca
 * layar, dan ia tidak menghilang begitu saja saat semuanya selesai.
 */

function meta(overrides: Partial<SearchMeta> = {}): SearchMeta {
  return {
    source: 'live',
    suppliersResponded: ['SKY', 'NOVA', 'ORBIT'],
    suppliersTimedOut: ['LUNA'],
    suppliersUnavailable: ['ZEPH'],
    latencyMs: 1_200,
    partial: true,
    ...overrides,
  }
}

describe('menyebut angka, bukan "sedang memuat"', () => {
  test('berapa dari berapa penyedia sudah menjawab', () => {
    // "3 dari 5" memberi tahu dua hal sekaligus: daftarnya belum lengkap, dan
    // sebagian besar sudah ada. "Sedang memuat" tidak mengatakan keduanya.
    render(<PartialResultNotice meta={meta()} isRefreshing={false} />)

    expect(screen.getByText(/3 dari 5 penyedia/)).toBeInTheDocument()
  })

  test('yang masih dicari dibedakan dari yang tidak dapat dihubungi', () => {
    render(<PartialResultNotice meta={meta()} isRefreshing={false} />)

    expect(screen.getByText(/akan muncul sendiri/)).toBeInTheDocument()
  })

  test('tanpa yang kehabisan waktu, sisanya dinyatakan tidak dapat dihubungi', () => {
    // Bedanya penting: yang satu akan datang, yang satu tidak. Menjanjikan
    // hasil yang tidak akan pernah datang membuat pengguna menunggu sia-sia.
    render(
      <PartialResultNotice
        meta={meta({ suppliersTimedOut: [], suppliersUnavailable: ['ZEPH', 'LUNA'] })}
        isRefreshing={false}
      />,
    )

    expect(screen.getByText(/sedang tidak dapat dihubungi/)).toBeInTheDocument()
  })
})

describe('ketika semuanya sudah menjawab', () => {
  test('menyatakan daftarnya lengkap, bukan menghilang', () => {
    // Pengguna yang tadi melihat "3 dari 5" perlu tahu angka itu sudah
    // selesai berubah.
    render(
      <PartialResultNotice
        meta={meta({
          partial: false,
          suppliersResponded: ['SKY', 'NOVA', 'ORBIT', 'LUNA', 'ZEPH'],
          suppliersTimedOut: [],
          suppliersUnavailable: [],
        })}
        isRefreshing={false}
      />,
    )

    expect(screen.getByText(/Seluruh 5 penyedia sudah menjawab/)).toBeInTheDocument()
  })
})

describe('hasil dari cache menyebut umurnya', () => {
  test('umur dalam menit', () => {
    // Klien yang tidak tahu datanya berumur empat menit tidak dapat
    // memutuskan apa pun tentangnya — dan harga hotel memang berubah dalam
    // hitungan menit.
    render(
      <PartialResultNotice
        meta={meta({
          partial: false,
          source: 'cache',
          ageMs: 240_000,
          suppliersTimedOut: [],
          suppliersUnavailable: [],
        })}
        isRefreshing={false}
      />,
    )

    expect(screen.getByText(/Diperbarui 4 menit lalu/)).toBeInTheDocument()
  })

  test('umur di bawah satu menit disebut baru', () => {
    render(
      <PartialResultNotice
        meta={meta({
          partial: false,
          source: 'cache',
          ageMs: 12_000,
          suppliersTimedOut: [],
          suppliersUnavailable: [],
        })}
        isRefreshing={false}
      />,
    )

    expect(screen.getByText(/Baru diperbarui/)).toBeInTheDocument()
  })
})

describe('pengumuman untuk pembaca layar', () => {
  test('memakai aria-live polite', () => {
    // Tanpa ini, pengguna pembaca layar membaca sepuluh hasil dan tidak
    // pernah tahu tiga hotel termurah yang datang belakangan.
    //
    // `polite`, bukan `assertive`: yang kedua memotong pengguna di tengah
    // nama hotel setiap kali satu penyedia menjawab.
    const view = render(<PartialResultNotice meta={meta()} isRefreshing={false} />)
    const region = view.container.querySelector('[aria-live]')

    expect(region).toHaveAttribute('aria-live', 'polite')
    expect(region).toHaveAttribute('aria-atomic', 'true')
  })
})

describe('sedang memperbarui', () => {
  test('dinyatakan terpisah dari keadaan parsial', () => {
    render(<PartialResultNotice meta={meta({ partial: false })} isRefreshing />)

    expect(screen.getByText('Memperbarui hasil…')).toBeInTheDocument()
  })
})
