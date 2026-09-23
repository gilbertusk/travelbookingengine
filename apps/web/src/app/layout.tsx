import type { Metadata } from 'next'
import { Inter, Instrument_Serif } from 'next/font/google'
import type { ReactNode } from 'react'
import { SiteFooter } from '@/components/layout/site-footer'
import { SiteHeader } from '@/components/layout/site-header'
import { Providers } from '@/components/providers'
import { publicConfig } from '@/config'
import '@/styles/globals.css'

/**
 * Dua typeface, dimuat lewat next/font.
 *
 * next/font mengunduh dan menyajikan font dari domain sendiri, sehingga tidak
 * ada permintaan ke Google saat halaman dibuka — satu ketergantungan pihak
 * ketiga lebih sedikit pada jalur render pertama, dan tidak ada alamat IP
 * pengunjung yang ikut terkirim ke sana.
 *
 * Subset `latin` saja. Memuat seluruh rentang karakter menambah ratusan
 * kilobyte untuk glif yang tidak pernah muncul di antarmuka berbahasa
 * Indonesia.
 */
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
})

const instrumentSerif = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  variable: '--font-instrument-serif',
  display: 'swap',
})

export const metadata: Metadata = {
  title: {
    default: `${publicConfig.appName} — cari dan pesan penginapan`,
    template: `%s · ${publicConfig.appName}`,
  },
  description:
    'Bandingkan penginapan dari beberapa penyedia sekaligus, lalu pesan dalam satu alur.',
}

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    // suppressHydrationWarning dibutuhkan next-themes: atribut tema ditulis
    // skripnya sebelum React menghidrasi, sehingga HTML server dan klien
    // memang berbeda pada satu atribut itu — dan hanya pada atribut itu.
    <html
      lang="id"
      suppressHydrationWarning
      className={`${inter.variable} ${instrumentSerif.variable}`}
    >
      <body className="flex min-h-dvh flex-col">
        <Providers>
          <SiteHeader />
          <main id="konten" className="flex-1">
            {children}
          </main>
          <SiteFooter />
        </Providers>
      </body>
    </html>
  )
}
