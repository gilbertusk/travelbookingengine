'use client'

import { Button } from '@tbe/ui/button'
import { cn } from '@tbe/ui/cn'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

export const NAV_ITEMS = [
  { href: '/', label: 'Kesehatan supplier' },
  { href: '/tinjauan', label: 'Tinjauan' },
  { href: '/kendali', label: 'Kendali mock supplier' },
  { href: '/supplier', label: 'Konfigurasi supplier' },
  { href: '/markup', label: 'Aturan markup' },
  { href: '/analitik', label: 'Analitik' },
] as const

/** Navigasi panel. Keluar mencabut refresh token di auth-service, bukan hanya menghapus cookie. */
export function OpsNav({ onSignOut }: { readonly onSignOut?: () => Promise<void> }) {
  const pathname = usePathname()

  return (
    <nav
      aria-label="Panel operator"
      className="flex flex-wrap items-center gap-1 border-b px-4 py-2"
    >
      <span className="mr-4 font-medium">Panel operator</span>
      {NAV_ITEMS.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={pathname === item.href ? 'page' : undefined}
          className={cn(
            'rounded-md px-3 py-2 text-small',
            pathname === item.href ? 'bg-muted font-medium' : 'text-muted-foreground',
          )}
        >
          {item.label}
        </Link>
      ))}
      <Button
        className="ml-auto"
        size="sm"
        variant="ghost"
        onClick={async () => {
          await (onSignOut ?? signOut)()
        }}
      >
        Keluar
      </Button>
    </nav>
  )
}

async function signOut(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST' })
  window.location.assign('/masuk')
}
