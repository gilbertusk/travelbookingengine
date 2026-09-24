import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { FilterChips, FiltersPanel } from './filters-panel'
import type { SearchCriteria } from '@/features/search/criteria'

/**
 * Penyaring dan chip-nya.
 *
 * Seluruh perubahan dilaporkan sebagai KRITERIA BARU, bukan disimpan di
 * dalam komponen. Pemanggilnya yang menuliskannya ke URL — dan itu yang
 * membuat penyaring bertahan saat halaman dimuat ulang.
 */

function criteria(overrides: Partial<SearchCriteria> = {}): SearchCriteria {
  return {
    city: 'Bali',
    checkIn: '2026-11-10',
    checkOut: '2026-11-12',
    guests: 2,
    sort: 'relevansi',
    amenities: [],
    refundableOnly: false,
    breakfastIncluded: false,
    ...overrides,
  }
}

describe('penyaring melaporkan kriteria baru', () => {
  test('memilih bintang minimum', async () => {
    const onChange = vi.fn()
    render(<FiltersPanel criteria={criteria()} onChange={onChange} />)

    await userEvent.click(screen.getByRole('button', { name: /4 bintang ke atas/ }))

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ minStarRating: 4 }))
  })

  test('menekan lagi melepaskannya', async () => {
    const onChange = vi.fn()
    render(<FiltersPanel criteria={criteria({ minStarRating: 4 })} onChange={onChange} />)

    await userEvent.click(screen.getByRole('button', { name: /4 bintang ke atas/ }))

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ minStarRating: undefined }))
  })

  test('memilih fasilitas menambahkannya ke daftar', async () => {
    const onChange = vi.fn()
    render(<FiltersPanel criteria={criteria({ amenities: ['pool'] })} onChange={onChange} />)

    await userEvent.click(screen.getByRole('button', { name: 'WiFi' }))

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ amenities: ['pool', 'wifi'] }))
  })

  test('melepas fasilitas menyisakan yang lain', async () => {
    const onChange = vi.fn()
    render(
      <FiltersPanel criteria={criteria({ amenities: ['pool', 'wifi'] })} onChange={onChange} />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Kolam renang' }))

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ amenities: ['wifi'] }))
  })

  test('kotak centang syarat pemesanan', async () => {
    const onChange = vi.fn()
    render(<FiltersPanel criteria={criteria()} onChange={onChange} />)

    await userEvent.click(screen.getByLabelText('Bisa dibatalkan'))

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ refundableOnly: true }))
  })

  test('hapus semua hanya menghapus penyaring, bukan kriteria pencarian', async () => {
    // Kota, tanggal, dan jumlah tamu bukan penyaring — menghapusnya berarti
    // membatalkan pencarian, bukan melonggarkannya.
    const onChange = vi.fn()
    render(
      <FiltersPanel
        criteria={criteria({ minStarRating: 4, amenities: ['pool'], refundableOnly: true })}
        onChange={onChange}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Hapus semua' }))

    expect(onChange).toHaveBeenCalledWith({
      ...criteria(),
      minStarRating: undefined,
      maxTotalMinor: undefined,
      amenities: [],
      refundableOnly: false,
      breakfastIncluded: false,
    })
  })

  test('tombol hapus semua tidak muncul saat tidak ada penyaring', () => {
    render(<FiltersPanel criteria={criteria()} onChange={vi.fn()} />)

    expect(screen.queryByRole('button', { name: 'Hapus semua' })).not.toBeInTheDocument()
  })
})

describe('keadaan tombol diumumkan', () => {
  test('aria-pressed mengikuti penyaring yang aktif', () => {
    // Pembaca layar mengumumkan "ditekan" atau "tidak ditekan" — itulah yang
    // menjelaskan keadaannya tanpa perlu melihat warnanya.
    render(<FiltersPanel criteria={criteria({ minStarRating: 4 })} onChange={vi.fn()} />)

    expect(screen.getByRole('button', { name: /4 bintang ke atas/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByRole('button', { name: /5 bintang ke atas/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })
})

describe('chip penyaring aktif', () => {
  test('tidak muncul saat tidak ada penyaring', () => {
    const view = render(<FilterChips criteria={criteria()} onChange={vi.fn()} />)

    expect(view.container).toBeEmptyDOMElement()
  })

  test('satu chip per penyaring', () => {
    render(
      <FilterChips
        criteria={criteria({ minStarRating: 4, refundableOnly: true, amenities: ['pool'] })}
        onChange={vi.fn()}
      />,
    )

    expect(screen.getAllByRole('button')).toHaveLength(3)
  })

  test('melepas chip hanya menghapus penyaringnya sendiri', async () => {
    const onChange = vi.fn()
    render(
      <FilterChips
        criteria={criteria({ minStarRating: 4, refundableOnly: true })}
        onChange={onChange}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: /4 bintang ke atas/ }))

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ minStarRating: undefined, refundableOnly: true }),
    )
  })

  test('dapat dioperasikan dengan papan ketik', async () => {
    const onChange = vi.fn()
    render(<FilterChips criteria={criteria({ refundableOnly: true })} onChange={onChange} />)

    await userEvent.tab()
    await userEvent.keyboard('{Enter}')

    expect(onChange).toHaveBeenCalled()
  })
})
