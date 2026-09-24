import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { SearchBar } from './search-bar'
import { renderWithQuery } from '@/testing/render'

/**
 * Batang pencarian.
 *
 * Kriteria dikirim lewat URL, jadi yang dijaga di sini adalah bentuk URL-nya
 * — tautan yang dibagikan pengguna adalah tautan itu — dan penolakan masukan
 * yang tidak lengkap sebelum satu pun permintaan terkirim.
 */

const push = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
}))

beforeEach(() => {
  push.mockReset()
  // Saran otomatis tidak diuji di sini; yang penting ia tidak menembak
  // jaringan sungguhan dan tidak mengotori keluaran pengujian.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify({ data: { cities: [], properties: [] }, error: null }), {
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

const CRITERIA = {
  city: 'Bali',
  checkIn: '2026-11-10',
  checkOut: '2026-11-12',
  guests: 2,
  sort: 'relevansi' as const,
  amenities: [] as string[],
  refundableOnly: false,
  breakfastIncluded: false,
}

describe('aksesibilitas bidang', () => {
  test('setiap bidang punya label sungguhan, bukan hanya placeholder', () => {
    renderWithQuery(<SearchBar />)

    // getByLabelText gagal kalau labelnya tidak tertaut ke kendalinya, jadi
    // pengujian ini sekaligus memeriksa tautan htmlFor/id.
    expect(screen.getByLabelText(/Kota atau daerah/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Tanggal menginap/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Tamu/)).toBeInTheDocument()
  })

  test('dapat dioperasikan dengan keyboard sampai tombol cari', async () => {
    renderWithQuery(<SearchBar />)
    const user = userEvent.setup()

    await user.tab()
    expect(screen.getByLabelText(/Kota atau daerah/)).toHaveFocus()

    await user.tab()
    expect(screen.getByLabelText(/Tanggal menginap/)).toHaveFocus()

    await user.tab()
    expect(screen.getByLabelText(/Tamu/)).toHaveFocus()

    await user.tab()
    expect(screen.getByRole('button', { name: /Cari/ })).toHaveFocus()
  })

  test('masukan kota berperan combobox', () => {
    // Tanpa peran dan atribut yang benar, munculnya daftar saran tidak
    // diumumkan sama sekali kepada pengguna pembaca layar.
    const input = screen.queryByRole('combobox', { name: /Kota atau daerah/ })

    renderWithQuery(<SearchBar />)

    expect(input ?? screen.getByRole('combobox', { name: /Kota atau daerah/ })).toBeInTheDocument()
  })
})

describe('kriteria yang tidak lengkap ditolak sebelum dikirim', () => {
  test('tanpa kota', async () => {
    renderWithQuery(<SearchBar />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: /Cari/ }))

    expect(screen.getByRole('alert')).toHaveTextContent(/kota atau daerah tujuan/i)
    expect(push).not.toHaveBeenCalled()
  })

  test('tanpa tanggal', async () => {
    renderWithQuery(<SearchBar />)
    const user = userEvent.setup()

    await user.type(screen.getByLabelText(/Kota atau daerah/), 'Bali')
    await user.click(screen.getByRole('button', { name: /Cari/ }))

    expect(screen.getByRole('alert')).toHaveTextContent(/tanggal masuk dan keluar/i)
    expect(push).not.toHaveBeenCalled()
  })

  test('pesan galat diumumkan, bukan hanya terlihat', async () => {
    renderWithQuery(<SearchBar />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: /Cari/ }))

    // `role="alert"` membuatnya diumumkan begitu muncul.
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })
})

describe('pengiriman', () => {
  test('menyusun URL dari kriteria yang lengkap', async () => {
    renderWithQuery(<SearchBar initial={CRITERIA} />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: /Cari/ }))

    expect(push).toHaveBeenCalledWith('/cari?kota=Bali&mulai=2026-11-10&selesai=2026-11-12')
  })

  test('nilai bawaan tidak ikut ke URL', async () => {
    // URL yang selalu memuat `&tamu=2&urut=relevansi` menjadi panjang tanpa
    // membawa keterangan apa pun — dan itulah URL yang dibagikan pengguna.
    renderWithQuery(<SearchBar initial={CRITERIA} />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: /Cari/ }))

    const target = push.mock.calls[0]?.[0] as string
    expect(target).not.toContain('tamu=')
    expect(target).not.toContain('urut=')
  })

  test('penyaring yang sedang aktif ikut terbawa', async () => {
    // Mengubah tanggal tidak boleh diam-diam menghapus penyaring harga yang
    // baru saja dipilih pengguna.
    renderWithQuery(<SearchBar initial={{ ...CRITERIA, minStarRating: 4, refundableOnly: true }} />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: /Cari/ }))

    const target = push.mock.calls[0]?.[0] as string
    expect(target).toContain('bintang=4')
    expect(target).toContain('refundable=1')
  })

  test('kriteria awal mengisi bidangnya', () => {
    renderWithQuery(<SearchBar initial={CRITERIA} />)

    expect(screen.getByLabelText(/Kota atau daerah/)).toHaveValue('Bali')
    expect(screen.getByLabelText(/Tanggal menginap/)).toHaveTextContent('10 Nov')
  })

  test('menampilkan keterangan saat tanggal belum dipilih', () => {
    renderWithQuery(<SearchBar />)

    expect(screen.getByLabelText(/Tanggal menginap/)).toHaveTextContent('Pilih tanggal')
  })
})
