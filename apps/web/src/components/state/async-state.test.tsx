import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { ApiError } from '@/lib/api-error'
import { AsyncState } from './async-state'

/**
 * Empat keadaan wajib.
 *
 * Yang paling mudah salah bukan keempat tampilannya, melainkan urutan
 * pemeriksaannya — dan urutan itu hanya terlihat lewat pengujian.
 */

function renderState(props: Partial<Parameters<typeof AsyncState<string[]>>[0]> = {}) {
  return render(
    <AsyncState<string[]>
      data={undefined}
      isLoading={false}
      error={null}
      skeleton={<div data-testid="skeleton" />}
      {...props}
    >
      {(data) => (
        <ul>
          {data.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </AsyncState>,
  )
}

describe('pemilihan keadaan', () => {
  test('menampilkan skeleton selama memuat', () => {
    renderState({ isLoading: true })

    expect(screen.getByTestId('skeleton')).toBeInTheDocument()
    expect(screen.getByText('Memuat')).toBeInTheDocument()
  })

  test('menandai wilayah sebagai sedang sibuk supaya pembaca layar tahu', () => {
    const { container } = renderState({ isLoading: true })

    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()
  })

  test('menampilkan isi saat data tersedia', () => {
    renderState({ data: ['Bali', 'Lombok'] })

    expect(screen.getByText('Bali')).toBeInTheDocument()
    expect(screen.queryByTestId('skeleton')).not.toBeInTheDocument()
  })

  test('menampilkan keadaan kosong saat data ada tetapi kosong', () => {
    renderState({
      data: [],
      isEmpty: (data) => data.length === 0,
      empty: { title: 'Tidak ada hasil', description: 'Coba ubah tanggalnya.' },
    })

    expect(screen.getByText('Tidak ada hasil')).toBeInTheDocument()
  })

  test('menjelaskan galat dalam bahasa manusia, bukan pesan server', () => {
    renderState({
      error: new ApiError({ kind: 'server', status: 500, code: 'X', message: 'ECONNRESET' }),
    })

    expect(screen.queryByText(/ECONNRESET/)).not.toBeInTheDocument()
    expect(screen.getByText(/Layanan sedang bermasalah/)).toBeInTheDocument()
  })

  test('keadaan galat menyediakan cara mencoba lagi', async () => {
    const onRetry = vi.fn()
    renderState({ error: new Error('gagal'), onRetry })

    await userEvent.click(screen.getByRole('button', { name: 'Coba lagi' }))

    expect(onRetry).toHaveBeenCalledOnce()
  })

  test('galat diumumkan sebagai peringatan', () => {
    renderState({ error: new Error('gagal') })

    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  test('data yang sudah ada menang atas galat pengambilan ulang', () => {
    // Pengambilan ulang di latar belakang yang gagal tidak boleh mengosongkan
    // layar. Hasil yang sudah dibaca pengguna hilang begitu saja, dan yang
    // tersisa adalah halaman galat untuk data yang sebenarnya masih ada.
    renderState({ data: ['Bali'], error: new Error('gagal memuat ulang') })

    expect(screen.getByText('Bali')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
