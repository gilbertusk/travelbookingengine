import type { ComponentProps } from 'react'
import { cn } from '@/lib/cn'

/**
 * Skeleton.
 *
 * Dipakai untuk menyerupai bentuk akhir konten, bukan sebagai kotak abu-abu
 * sembarang. Skeleton yang bentuknya berbeda dari hasilnya membuat halaman
 * melompat saat data tiba, dan lompatan itu terasa lebih lambat daripada
 * menunggu dengan bentuk yang benar.
 *
 * `animate-pulse` dimatikan sendiri oleh aturan prefers-reduced-motion di
 * globals.css.
 */
export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      aria-hidden="true"
      className={cn('animate-pulse rounded-md bg-muted', className)}
      {...props}
    />
  )
}
