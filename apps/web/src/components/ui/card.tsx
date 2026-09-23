import type { ComponentProps } from 'react'
import { cn } from '@/lib/cn'

/**
 * Kartu.
 *
 * Tanpa bayangan. Kartu di dalam daftar dibedakan dengan border tipis, bukan
 * elevasi — bayangan disimpan untuk elemen yang benar-benar melayang di atas
 * halaman, seperti dialog dan popover. Kalau semuanya berbayang, tidak ada
 * yang terlihat melayang.
 *
 * Padding 20px, bukan 12px. Kartu sempit membuat halaman terasa murah.
 */
export function Card({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('rounded-lg border border-border bg-card text-card-foreground', className)}
      {...props}
    />
  )
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1 p-5', className)} {...props} />
}

export function CardTitle({ className, children, ...props }: ComponentProps<'h3'>) {
  // children ditulis eksplisit, bukan ikut dalam spread: judul tanpa isi tidak
  // terbaca pembaca layar, dan linter hanya dapat memeriksanya bila anaknya
  // terlihat di JSX.
  return (
    <h3 className={cn('text-h3 font-medium', className)} {...props}>
      {children}
    </h3>
  )
}

export function CardDescription({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('text-small text-muted-foreground', className)} {...props} />
}

export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('p-5 pt-0', className)} {...props} />
}

export function CardFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex items-center gap-3 p-5 pt-0', className)} {...props} />
}
