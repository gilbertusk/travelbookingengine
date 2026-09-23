import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { renderWithQuery } from '@/testing/render'
import { RegisterForm } from './register-form'

/**
 * Formulir pendaftaran.
 *
 * Yang diuji bukan tampilannya, melainkan dua hal yang menentukan apakah
 * formulir ini dapat dipakai: pesan galat tertaut ke bidangnya, dan kegagalan
 * server sampai ke pengguna dalam bahasa manusia.
 */

const push = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}))

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  push.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('validasi masukan', () => {
  test('menolak kata sandi yang lebih pendek dari batas server', async () => {
    // Batasnya disamakan dengan auth-service supaya pengguna tidak mengetik
    // kata sandi lengkap lalu ditolak setelah permintaan terkirim.
    renderWithQuery(<RegisterForm />)
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('Nama'), 'Budi')
    await user.type(screen.getByLabelText('Surel'), 'budi@example.com')
    await user.type(screen.getByLabelText('Kata sandi'), 'pendek')
    await user.click(screen.getByRole('button', { name: /Buat akun/ }))

    // Teks "minimal 12 karakter" muncul dua kali di halaman — sebagai petunjuk
    // dan sebagai pesan galat. Yang diperiksa di sini pesan galatnya.
    expect(await screen.findByText('Kata sandi minimal 12 karakter.')).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('pesan galat tertaut ke bidangnya lewat aria-describedby', async () => {
    renderWithQuery(<RegisterForm />)
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('Surel'), 'bukan-surel')
    await user.click(screen.getByRole('button', { name: /Buat akun/ }))

    const field = await screen.findByLabelText('Surel')

    await waitFor(() => {
      expect(field).toHaveAttribute('aria-invalid', 'true')
    })

    const describedBy = field.getAttribute('aria-describedby') ?? ''
    expect(describedBy).toContain('email-error')
  })

  test('petunjuk bidang juga tertaut, bukan hanya terlihat', () => {
    renderWithQuery(<RegisterForm />)

    const password = screen.getByLabelText('Kata sandi')
    expect(password.getAttribute('aria-describedby') ?? '').toContain('password-hint')
  })
})

describe('kegagalan dari server', () => {
  test('menampilkan pesan yang dapat dibaca, bukan kode galat', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: 'EMAIL_TAKEN', message: 'Surel sudah terdaftar.' } }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      ),
    )

    renderWithQuery(<RegisterForm />)
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('Nama'), 'Budi')
    await user.type(screen.getByLabelText('Surel'), 'budi@example.com')
    await user.type(screen.getByLabelText('Kata sandi'), 'kataSandiPanjangAman')
    await user.click(screen.getByRole('button', { name: /Buat akun/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Surel sudah terdaftar.')
    expect(push).not.toHaveBeenCalled()
  })
})
