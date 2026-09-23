import Link from 'next/link'
import type { ReactNode } from 'react'

/**
 * Kerangka halaman autentikasi.
 *
 * Satu kolom sempit di tengah, tanpa kartu. Kartu di tengah halaman kosong
 * adalah bentuk yang paling sering dipakai template, dan tidak menambah apa
 * pun: tidak ada konten lain di sekelilingnya yang perlu dipisahkan darinya.
 */
export function AuthShell({
  title,
  description,
  children,
  footer,
}: {
  readonly title: string
  readonly description: string
  readonly children: ReactNode
  readonly footer: { readonly question: string; readonly href: string; readonly label: string }
}) {
  return (
    <div className="mx-auto flex w-full max-w-prose flex-col px-4 py-16 sm:px-6 sm:py-24">
      <h1 className="font-display text-h1">{title}</h1>
      <p className="mt-3 text-small text-muted-foreground">{description}</p>

      <div className="mt-10">{children}</div>

      <p className="mt-8 text-small text-muted-foreground">
        {footer.question}{' '}
        <Link
          href={footer.href}
          className="font-medium text-foreground underline underline-offset-4"
        >
          {footer.label}
        </Link>
      </p>
    </div>
  )
}
