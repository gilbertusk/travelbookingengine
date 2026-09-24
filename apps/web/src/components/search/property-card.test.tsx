import { render, screen, within } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { PropertyCard } from './property-card'
import type { SearchProperty } from '@/features/search/types'

/**
 * Kartu hasil.
 *
 * Yang diuji di sini adalah janji-janji yang dapat diingkari tanpa terlihat:
 * bahwa harga yang ditampilkan adalah harga jual, bahwa properti belum
 * terpetakan tidak menjadi tautan, dan bahwa nama tautannya tidak menelan
 * seluruh isi kartu.
 */

function money(amountMinor: number) {
  return { amountMinor, currency: 'IDR' as const }
}

function offer(overrides: Partial<SearchProperty['offers'][number]> = {}) {
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

function property(overrides: Partial<SearchProperty> = {}): SearchProperty {
  return {
    ref: 'prop-padma',
    mapped: true,
    slug: 'padma-bali-boutique-hotel',
    name: 'Padma Bali Boutique Hotel',
    city: 'Bali',
    starRating: 4,
    amenities: ['pool', 'wifi'],
    offers: [offer()],
    suppliers: ['SKY'],
    lowestTotal: money(1_332_000),
    ...overrides,
  }
}

function renderCard(overrides: Partial<SearchProperty> = {}) {
  return render(
    <PropertyCard property={property(overrides)} nights={2} query="kota=Bali" index={0} />,
  )
}

describe('harga', () => {
  test('yang ditampilkan adalah harga jual, bukan harga penyedia', () => {
    renderCard()

    expect(screen.getByText(/1\.332\.000/)).toBeInTheDocument()
    expect(screen.queryByText(/1\.000\.000/)).not.toBeInTheDocument()
  })

  test('rincian pajak terlihat tanpa diklik', () => {
    // Harga yang berubah di langkah terakhir pemesanan adalah cara tercepat
    // kehilangan kepercayaan.
    renderCard()

    expect(screen.getByText(/termasuk PPN/i)).toBeInTheDocument()
    expect(screen.getByText(/132\.000/)).toBeInTheDocument()
  })

  test('menyebut untuk berapa malam', () => {
    renderCard()

    expect(screen.getByText(/2 malam/)).toBeInTheDocument()
  })
})

describe('tautan ke halaman properti', () => {
  test('namanya menjadi tautan, membawa kriteria pencarian', () => {
    renderCard()

    const link = screen.getByRole('link', { name: 'Padma Bali Boutique Hotel' })

    expect(link).toHaveAttribute('href', '/properti/padma-bali-boutique-hotel?kota=Bali')
  })

  test('nama tautannya hanya nama hotel, bukan seluruh isi kartu', () => {
    // Membungkus kartu dengan `<a>` akan memasukkan harga, bintang, dan
    // seluruh fasilitas ke dalam nama tautan — satu tautan sepanjang
    // paragraf, dan mustahil dikenali dari daftar tautan pembaca layar.
    renderCard()

    const link = screen.getByRole('link')

    expect(link.textContent).toBe('Padma Bali Boutique Hotel')
  })

  test('properti belum terpetakan TIDAK menjadi tautan', () => {
    // Tanpa pemetaan tidak ada slug, dan tanpa slug tidak ada URL yang stabil.
    renderCard({ mapped: false, slug: undefined })

    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  test('properti belum terpetakan tetap ditampilkan, dengan keterangannya', () => {
    // Menyembunyikannya berarti kehilangan inventaris.
    renderCard({ mapped: false, slug: undefined, name: 'Kirana Bali Htl.' })

    expect(screen.getByText('Kirana Bali Htl.')).toBeInTheDocument()
    expect(screen.getByText(/properti baru dari penyedia/i)).toBeInTheDocument()
  })
})

describe('asal harga', () => {
  test('satu penyedia disebut namanya', () => {
    renderCard({ suppliers: ['SKY'] })

    expect(screen.getByText('via SKY')).toBeInTheDocument()
  })

  test('beberapa penyedia disebut jumlahnya', () => {
    // Pengguna memilih hotel, bukan penyedia. Yang perlu diketahui di daftar
    // adalah bahwa ada yang bisa dibandingkan.
    renderCard({ suppliers: ['SKY', 'NOVA', 'LUNA'] })

    expect(screen.getByText('3 penyedia menawarkan')).toBeInTheDocument()
  })
})

describe('fasilitas', () => {
  test('ditampilkan dengan label bahasa manusia', () => {
    renderCard({ amenities: ['airport_shuttle'] })

    expect(screen.getByText('Antar-jemput bandara')).toBeInTheDocument()
  })

  test('lebih dari empat diringkas', () => {
    renderCard({ amenities: ['pool', 'wifi', 'gym', 'spa', 'bar', 'parking'] })

    expect(screen.getByText('+2 lainnya')).toBeInTheDocument()
  })

  test('tanpa fasilitas tidak menampilkan daftar kosong', () => {
    const view = renderCard({ amenities: [] })

    expect(within(view.container).queryByRole('list')).not.toBeInTheDocument()
  })
})

describe('penjangkaran posisi baca', () => {
  test('setiap kartu membawa kunci jangkarnya', () => {
    // Dipakai useScrollAnchor untuk menahan posisi baca saat hasil baru
    // menyisip di atasnya.
    const view = renderCard()

    expect(view.container.querySelector('[data-anchor-key="prop-padma"]')).not.toBeNull()
  })
})

describe('kemunculan bertahap', () => {
  test('sepuluh kartu pertama diberi jeda 30ms', () => {
    const view = render(
      <PropertyCard property={property()} nights={2} query="kota=Bali" index={3} />,
    )
    const card = view.container.querySelector('article')

    expect(card).toHaveStyle({ animationDelay: '90ms' })
  })

  test('kartu kesebelas dan seterusnya tanpa jeda', () => {
    // Tanpa batas, kartu kelima puluh baru muncul satu setengah detik setelah
    // yang pertama, dan pengguna yang langsung menggulir melihat halaman kosong.
    const view = render(
      <PropertyCard property={property()} nights={2} query="kota=Bali" index={12} />,
    )
    const card = view.container.querySelector('article')

    expect(card?.style.animationDelay).toBe('')
  })
})
