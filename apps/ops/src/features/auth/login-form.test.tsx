import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { fakeFetch, renderWithQuery } from '@/testing/render'
import { LoginForm } from './LoginForm'

async function fill(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Surel'), 'sari@example.com')
  await user.type(screen.getByLabelText('Kata sandi'), 'rahasia-panjang')
  await user.click(screen.getByRole('button', { name: 'Masuk' }))
}

describe('LoginForm', () => {
  test('berhasil: rute server dipanggil, halaman tidak menerima token', async () => {
    const { calls } = fakeFetch({ 'POST /api/auth/login': { body: { data: { name: 'Sari' } } } })
    const onSignedIn = vi.fn()
    const user = userEvent.setup()
    renderWithQuery(<LoginForm onSignedIn={onSignedIn} />)

    await fill(user)

    await waitFor(() => {
      expect(onSignedIn).toHaveBeenCalled()
    })
    expect(calls[0]?.body).toEqual({ email: 'sari@example.com', password: 'rahasia-panjang' })
  })

  test('akun pelanggan: pesan dari server ditampilkan', async () => {
    fakeFetch({
      'POST /api/auth/login': {
        status: 403,
        body: { error: { code: 'NOT_OPERATOR', message: 'Akun ini bukan akun operator.' } },
      },
    })
    const user = userEvent.setup()
    renderWithQuery(<LoginForm onSignedIn={vi.fn()} />)

    await fill(user)

    expect(await screen.findByRole('alert')).toHaveTextContent('Akun ini bukan akun operator.')
  })

  test('jawaban tanpa pesan: pesan umum', async () => {
    fakeFetch({ 'POST /api/auth/login': { status: 502, body: null } })
    const user = userEvent.setup()
    renderWithQuery(<LoginForm onSignedIn={vi.fn()} />)

    await fill(user)

    expect(await screen.findByRole('alert')).toHaveTextContent('Masuk gagal.')
  })
})
