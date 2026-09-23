import { screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { AuthShell } from '@/components/auth/auth-shell'
import { renderWithQuery } from '@/testing/render'
import { SiteFooter } from './site-footer'
import { SiteHeader } from './site-header'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ error: { code: 'NO_SESSION' } }), { status: 401 }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('header', () => {
  test('menyediakan tautan lompat ke konten', () => {
    // Tanpa ini, pengguna keyboard harus menelusuri seluruh navigasi pada
    // setiap halaman sebelum sampai ke isinya.
    renderWithQuery(<SiteHeader />)

    expect(screen.getByRole('link', { name: 'Lompat ke konten' })).toHaveAttribute(
      'href',
      '#konten',
    )
  })

  test('navigasi utamanya diberi nama supaya dapat dilewati pembaca layar', () => {
    renderWithQuery(<SiteHeader />)

    expect(screen.getByRole('navigation', { name: 'Navigasi utama' })).toBeInTheDocument()
  })

  test('memuat tautan ke halaman inti', () => {
    renderWithQuery(<SiteHeader />)

    const nav = screen.getByRole('navigation', { name: 'Navigasi utama' })
    expect(nav).toHaveTextContent('Cari')
    expect(nav).toHaveTextContent('Pemesanan')
    expect(nav).toHaveTextContent('Sistem desain')
  })

  test('pengalih tema punya nama yang terbaca, bukan hanya ikon', () => {
    renderWithQuery(<SiteHeader />)

    expect(screen.getByRole('button', { name: /tampilan (gelap|terang)/i })).toBeInTheDocument()
  })
})

describe('footer', () => {
  test('menyatakan bahwa datanya berasal dari penyedia tiruan', () => {
    // Halaman pemesanan yang terlihat sungguhan tanpa keterangan ini dapat
    // disalahpahami sebagai layanan yang benar-benar menjual sesuatu.
    renderWithQuery(<SiteFooter />)

    expect(screen.getByText(/penyedia tiruan/)).toBeInTheDocument()
  })
})

describe('kerangka halaman autentikasi', () => {
  test('judulnya adalah satu-satunya h1 di halaman', () => {
    renderWithQuery(
      <AuthShell
        title="Masuk"
        description="Lanjutkan pemesananmu."
        footer={{ question: 'Belum punya akun?', href: '/daftar', label: 'Daftar' }}
      >
        <p>formulir</p>
      </AuthShell>,
    )

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'Daftar' })).toHaveAttribute('href', '/daftar')
  })
})
