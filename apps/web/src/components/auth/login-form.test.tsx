import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { getAccessToken, setAccessToken } from '@/lib/access-token'
import { renderWithQuery } from '@/testing/render'
import { LoginForm } from './login-form'

const push = vi.fn()
let searchParams = new URLSearchParams()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
  useSearchParams: () => searchParams,
}))

const fetchMock = vi.fn<typeof fetch>()

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const BUDI = {
  id: 'u1',
  email: 'budi@example.com',
  name: 'Budi',
  createdAt: '2026-01-01T00:00:00Z',
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  push.mockReset()
  searchParams = new URLSearchParams()
  setAccessToken(undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function submitCredentials(): Promise<void> {
  const user = userEvent.setup()

  await user.type(screen.getByLabelText('Surel'), 'budi@example.com')
  await user.type(screen.getByLabelText('Kata sandi'), 'kataSandiPanjangAman')
  await user.click(screen.getByRole('button', { name: /Masuk/ }))
}

describe('masuk berhasil', () => {
  test('menyimpan token dan membawa pengguna ke beranda', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ user: BUDI, accessToken: 'token-abc' }))

    renderWithQuery(<LoginForm />)
    await submitCredentials()

    await vi.waitFor(() => {
      expect(push).toHaveBeenCalledWith('/')
    })
    expect(getAccessToken()).toBe('token-abc')
  })

  test('mengembalikan pengguna ke halaman yang semula ia tuju', async () => {
    searchParams = new URLSearchParams({ lanjut: '/bookings/bkg_1' })
    fetchMock.mockResolvedValue(jsonResponse({ user: BUDI, accessToken: 'token-abc' }))

    renderWithQuery(<LoginForm />)
    await submitCredentials()

    await vi.waitFor(() => {
      expect(push).toHaveBeenCalledWith('/bookings/bkg_1')
    })
  })

  test('tujuan ke situs lain diabaikan', async () => {
    // Tanpa ini, tautan `/masuk?lanjut=https://situs-palsu` melempar pengguna
    // ke situs lain tepat setelah ia berhasil masuk.
    searchParams = new URLSearchParams({ lanjut: 'https://situs-palsu.test' })
    fetchMock.mockResolvedValue(jsonResponse({ user: BUDI, accessToken: 'token-abc' }))

    renderWithQuery(<LoginForm />)
    await submitCredentials()

    await vi.waitFor(() => {
      expect(push).toHaveBeenCalledWith('/')
    })
  })
})

describe('masuk gagal', () => {
  test('menampilkan pesan yang sama untuk surel dan kata sandi salah', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: { code: 'UNAUTHORIZED', message: 'Surel atau kata sandi salah' } },
        401,
      ),
    )

    renderWithQuery(<LoginForm />)
    await submitCredentials()

    // Pesan datang dari [humanMessage], bukan dari server: galat 401 di sini
    // berarti sesi tidak berlaku, dan itulah yang perlu diketahui pengguna.
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(push).not.toHaveBeenCalled()
  })

  test('menolak surel yang jelas salah bentuk sebelum mengirim apa pun', async () => {
    renderWithQuery(<LoginForm />)
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('Surel'), 'bukan-surel')
    await user.type(screen.getByLabelText('Kata sandi'), 'apa-saja')
    await user.click(screen.getByRole('button', { name: /Masuk/ }))

    expect(await screen.findByText('Masukkan alamat surel yang benar.')).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
