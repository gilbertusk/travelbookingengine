import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { SearchBar } from './search-bar'

/**
 * Batang pencarian.
 *
 * Penyambungan ke search-service menyusul, tetapi bentuk dan aksesibilitasnya
 * dijaga sejak sekarang — bidang tanpa label yang lolos ke Step 14 akan
 * tertutup oleh pekerjaan di atasnya dan tidak pernah diperbaiki.
 */

const push = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}))

beforeEach(() => {
  push.mockReset()
})

describe('aksesibilitas bidang', () => {
  test('setiap bidang punya label sungguhan, bukan hanya placeholder', () => {
    render(<SearchBar />)

    // getByLabelText gagal kalau labelnya tidak tertaut ke kendalinya, jadi
    // pengujian ini sekaligus memeriksa tautan htmlFor/id.
    expect(screen.getByLabelText(/Kota atau daerah/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Tanggal menginap/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Tamu/)).toBeInTheDocument()
  })

  test('dapat dioperasikan dengan keyboard sampai tombol cari', async () => {
    render(<SearchBar />)
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
})

describe('pengiriman', () => {
  test('membawa kota dan jumlah tamu ke halaman hasil', async () => {
    render(<SearchBar />)
    const user = userEvent.setup()

    await user.type(screen.getByLabelText(/Kota atau daerah/), 'Bali')
    await user.click(screen.getByRole('button', { name: /Cari/ }))

    expect(push).toHaveBeenCalledWith('/cari?kota=Bali&tamu=2')
  })

  test('tanggal yang belum dipilih tidak ikut dikirim sebagai nilai kosong', async () => {
    render(<SearchBar />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: /Cari/ }))

    const target = push.mock.calls[0]?.[0] as string
    expect(target).not.toContain('mulai=')
    expect(target).not.toContain('selesai=')
  })

  test('menampilkan keterangan saat tanggal belum dipilih', () => {
    render(<SearchBar />)

    expect(screen.getByLabelText(/Tanggal menginap/)).toHaveTextContent('Pilih tanggal')
  })
})
