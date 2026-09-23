import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { getAccessToken, setAccessToken } from '@/lib/access-token'
import { renderWithQuery } from '@/testing/render'
import { AccountMenu } from './account-menu'

/**
 * Menu akun.
 *
 * Tiga keadaan, dan ketiganya harus ditangani. Yang paling mudah terlewat
 * adalah keadaan pertama: selama sesi dipulihkan, tombol "Masuk" tidak boleh
 * sempat muncul bagi pengguna yang sebenarnya sudah masuk.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
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
  setAccessToken(undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('keadaan menu akun', () => {
  test('tidak menampilkan tombol masuk selama sesi masih dipulihkan', () => {
    fetchMock.mockReturnValue(new Promise(() => undefined))

    renderWithQuery(<AccountMenu />)

    expect(screen.queryByRole('link', { name: 'Masuk' })).not.toBeInTheDocument()
  })

  test('menawarkan masuk dan daftar kepada pengunjung tanpa sesi', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'NO_SESSION' } }, 401))

    renderWithQuery(<AccountMenu />)

    expect(await screen.findByRole('link', { name: 'Masuk' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Daftar' })).toBeInTheDocument()
  })

  test('menampilkan nama pengguna setelah sesi dipulihkan', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ accessToken: 'token-abc' }))
      .mockResolvedValueOnce(jsonResponse({ data: BUDI, error: null }))

    renderWithQuery(<AccountMenu />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Budi/ })).toBeInTheDocument()
    })
  })

  test('sesi yang tidak berlaku diperlakukan sebagai belum masuk, bukan sebagai galat', async () => {
    // Melempar galat di sini akan membuat setiap halaman publik menampilkan
    // keadaan galat kepada pengunjung yang memang belum pernah masuk.
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ accessToken: 'token-basi' }))
      .mockResolvedValue(jsonResponse({ data: null, error: { code: 'UNAUTHORIZED' } }, 401))

    renderWithQuery(<AccountMenu />)

    expect(await screen.findByRole('link', { name: 'Masuk' })).toBeInTheDocument()
  })
})

describe('keluar', () => {
  test('membuang token dari memori dan mengembalikan tampilan ke keadaan tamu', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ accessToken: 'token-abc' }))
      .mockResolvedValueOnce(jsonResponse({ data: BUDI, error: null }))
      .mockResolvedValue(jsonResponse({ ok: true }))

    renderWithQuery(<AccountMenu />)
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: /Budi/ }))
    await user.click(await screen.findByRole('button', { name: /Keluar/ }))

    await waitFor(() => {
      expect(getAccessToken()).toBeUndefined()
    })
  })
})
