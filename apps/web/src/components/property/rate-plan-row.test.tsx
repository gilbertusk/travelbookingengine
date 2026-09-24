import { render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { RatePlanRow } from './rate-plan-row'
import type { Offer } from '@/features/search/types'

/**
 * Baris tarif kamar.
 *
 * FR-11 mewajibkan kebijakan pembatalan dan inklusi TERLIHAT TANPA DIKLIK.
 * Itu kewajiban, dan berkas ini yang menjaganya tidak diam-diam berubah
 * menjadi accordion suatu hari nanti.
 */

function money(amountMinor: number) {
  return { amountMinor, currency: 'IDR' as const }
}

function offer(overrides: Partial<Offer> = {}): Offer {
  return {
    supplier: 'SKY',
    supplierPropertyId: 'sky-1',
    supplierRatePlanId: 'rp-1',
    roomTypeName: 'Deluxe',
    ratePlanName: 'Refundable with Breakfast',
    refundable: true,
    freeCancellationDays: 3,
    breakfastIncluded: true,
    unitsLeft: 5,
    total: money(1_332_000),
    base: money(1_000_000),
    markup: money(200_000),
    tax: money(132_000),
    taxName: 'PPN',
    ...overrides,
  }
}

function renderRow(overrides: Partial<Offer> = {}, isCheapest = false) {
  return render(
    <ul>
      <RatePlanRow offer={offer(overrides)} nights={2} isCheapest={isCheapest} />
    </ul>,
  )
}

describe('kebijakan pembatalan terlihat tanpa diklik (FR-11)', () => {
  test('tenggat gratis batal disebutkan', () => {
    renderRow({ refundable: true, freeCancellationDays: 3 })

    expect(screen.getByText('Gratis batal sampai 3 hari sebelum menginap')).toBeInTheDocument()
  })

  test('tarif tanpa pembatalan dinyatakan jelas', () => {
    // Inilah satu-satunya hal yang membedakan dua tarif yang harganya berbeda
    // seratus ribu. Pengguna yang harus mengklik untuk mengetahuinya akan
    // memilih yang murah tanpa tahu apa yang dilepaskannya.
    renderRow({ refundable: false, freeCancellationDays: undefined })

    expect(screen.getByText('Tidak bisa dibatalkan')).toBeInTheDocument()
  })

  test('refundable tanpa tenggat tetap dinyatakan dapat dibatalkan', () => {
    renderRow({ refundable: true, freeCancellationDays: undefined })

    expect(screen.getByText('Bisa dibatalkan')).toBeInTheDocument()
  })

  test('tenggat nol hari berarti sampai hari menginap', () => {
    renderRow({ refundable: true, freeCancellationDays: 0 })

    expect(screen.getByText('Bisa dibatalkan sampai hari menginap')).toBeInTheDocument()
  })

  test('tidak ada tombol yang menyembunyikan keterangannya', () => {
    // Satu-satunya tombol yang boleh ada di baris ini adalah "Pilih".
    renderRow()

    const buttons = screen.getAllByRole('button')

    expect(buttons).toHaveLength(1)
    expect(buttons[0]).toHaveTextContent('Pilih')
  })
})

describe('inklusi terlihat tanpa diklik (FR-11)', () => {
  test('sarapan yang termasuk disebutkan', () => {
    renderRow({ breakfastIncluded: true })

    expect(screen.getByText('Termasuk sarapan')).toBeInTheDocument()
  })

  test('tanpa sarapan juga disebutkan, bukan dibiarkan kosong', () => {
    // Ketiadaan keterangan tidak dapat dibedakan dari keterangan yang lupa
    // ditulis.
    renderRow({ breakfastIncluded: false })

    expect(screen.getByText('Tanpa sarapan')).toBeInTheDocument()
  })
})

describe('harga', () => {
  test('harga jual beserta pajaknya', () => {
    renderRow()

    expect(screen.getByText(/1\.332\.000/)).toBeInTheDocument()
    expect(screen.getByText(/termasuk PPN/i)).toBeInTheDocument()
  })
})

describe('asal dan sisa kamar', () => {
  test('penyedia disebut — di halaman ini pengguna sedang membandingkan', () => {
    renderRow({ supplier: 'NOVA' })

    expect(screen.getByText(/via NOVA/)).toBeInTheDocument()
  })

  test('sisa kamar sedikit disebutkan', () => {
    renderRow({ unitsLeft: 2 })

    expect(screen.getByText(/tinggal 2 kamar/)).toBeInTheDocument()
  })

  test('sisa kamar banyak TIDAK disebutkan', () => {
    // Menyebutnya hanya menakut-nakuti tanpa membantu keputusan.
    renderRow({ unitsLeft: 9 })

    expect(screen.queryByText(/tinggal/)).not.toBeInTheDocument()
  })
})

describe('penanda termurah', () => {
  test('ditandai saat memang termurah', () => {
    renderRow({}, true)

    expect(screen.getByText('Termurah')).toBeInTheDocument()
  })

  test('tidak ditandai saat bukan', () => {
    renderRow({}, false)

    expect(screen.queryByText('Termurah')).not.toBeInTheDocument()
  })
})
