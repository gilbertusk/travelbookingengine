import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { OpsNav } from './OpsNav'

vi.mock('next/navigation', () => ({ usePathname: () => '/tinjauan' }))

describe('OpsNav', () => {
  test('halaman aktif ditandai untuk pembaca layar', () => {
    render(<OpsNav />)

    expect(screen.getByRole('link', { name: 'Tinjauan' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Analitik' })).not.toHaveAttribute('aria-current')
  })

  test('keluar memanggil penangan keluar', async () => {
    const onSignOut = vi.fn(async () => {
      await Promise.resolve()
    })
    render(<OpsNav onSignOut={onSignOut} />)

    await userEvent.setup().click(screen.getByRole('button', { name: 'Keluar' }))

    expect(onSignOut).toHaveBeenCalled()
  })
})
