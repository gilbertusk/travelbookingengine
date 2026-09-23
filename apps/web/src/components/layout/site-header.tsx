import Link from 'next/link'
import { publicConfig } from '@/config'
import { AccountMenu } from './account-menu'
import { ThemeToggle } from './theme-toggle'

/**
 * Header.
 *
 * Wordmark serif, bukan logo bergambar. Satu keputusan tipografi yang
 * dijalankan konsisten terbaca lebih disengaja daripada ikon generik yang
 * diambil dari pustaka.
 *
 * Header ini Server Component; hanya menu akun dan pengalih tema yang
 * berjalan di klien — CONVENTIONS.md bagian 13 meminta `'use client'`
 * ditempatkan sedalam mungkin di pohon komponen.
 */

const NAV_LINKS = [
  { href: '/', label: 'Cari' },
  { href: '/bookings', label: 'Pemesanan' },
  { href: '/design-system', label: 'Sistem desain' },
] as const

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur-sm">
      {/* Tautan lompat: pengguna keyboard tidak perlu menelusuri seluruh
          navigasi pada setiap halaman untuk sampai ke isinya. */}
      <a
        href="#konten"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-card focus:px-4 focus:py-2 focus:text-small"
      >
        Lompat ke konten
      </a>

      <div className="mx-auto flex h-16 max-w-content items-center gap-6 px-4 sm:px-6">
        <Link href="/" className="font-display text-h3 tracking-tight">
          {publicConfig.appName}
        </Link>

        <nav aria-label="Navigasi utama" className="hidden sm:block">
          <ul className="flex items-center gap-1">
            {NAV_LINKS.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className="rounded-md px-3 py-2 text-small text-muted-foreground transition-colors hover:text-foreground"
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="ml-auto flex items-center gap-1">
          <ThemeToggle />
          <AccountMenu />
        </div>
      </div>
    </header>
  )
}
