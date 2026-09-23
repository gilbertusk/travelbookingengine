import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeProvider } from 'next-themes'
import { describe, expect, test } from 'vitest'
import { ThemeToggle } from './theme-toggle'

/**
 * Pengalih tema.
 *
 * Dark mode bekerja lewat redefinisi token pada atribut `data-theme`, bukan
 * lewat kelas `dark:` berisi warna di komponen. Pengujian ini menjaga
 * mekanismenya: yang berubah hanya satu atribut pada elemen akar.
 */
function renderToggle() {
  return render(
    <ThemeProvider attribute="data-theme" defaultTheme="light">
      <ThemeToggle />
    </ThemeProvider>,
  )
}

describe('pengalih tema', () => {
  test('punya nama yang terbaca, bukan hanya ikon', () => {
    renderToggle()

    expect(screen.getByRole('button', { name: 'Ganti ke tampilan gelap' })).toBeInTheDocument()
  })

  test('mengganti tema lewat atribut data-theme pada elemen akar', async () => {
    renderToggle()

    await userEvent.click(screen.getByRole('button'))

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  test('namanya ikut berubah setelah tema berganti', async () => {
    renderToggle()

    await userEvent.click(screen.getByRole('button'))

    expect(
      await screen.findByRole('button', { name: 'Ganti ke tampilan terang' }),
    ).toBeInTheDocument()
  })
})
