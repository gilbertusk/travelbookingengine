import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { Providers } from '@/components/providers'
import '@/styles/globals.css'

/**
 * Tanpa next/font: panel internal memakai font sistem dari token
 * (`--font-sans` jatuh ke ui-sans-serif). Satu unduhan font lebih sedikit
 * untuk aplikasi yang tidak dilihat publik.
 */
export const metadata: Metadata = {
  title: { default: 'Panel operator', template: '%s · Panel operator' },
  robots: { index: false, follow: false },
}

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="id" suppressHydrationWarning>
      <body className="min-h-dvh">
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
