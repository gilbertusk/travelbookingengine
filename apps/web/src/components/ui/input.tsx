import type { ComponentProps } from 'react'
import { cn } from '@/lib/cn'

/**
 * Input teks.
 *
 * Tidak punya prop `label`. Label adalah elemen tersendiri yang ditautkan
 * lewat `htmlFor`, supaya mengklik label memindahkan fokus ke input dan
 * pembaca layar membacakan keduanya sebagai satu kesatuan. Placeholder
 * bukan pengganti label — ia hilang begitu pengguna mengetik.
 */
export function Input({ className, type = 'text', ...props }: ComponentProps<'input'>) {
  return (
    <input
      type={type}
      className={cn(
        'flex h-11 w-full rounded-md border border-input bg-card px-3 py-2 text-body',
        'placeholder:text-muted-foreground',
        'transition-colors duration-200 ease-[var(--ease-enter)]',
        'hover:border-muted-foreground/40',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'aria-invalid:border-destructive aria-invalid:hover:border-destructive',
        className,
      )}
      {...props}
    />
  )
}
