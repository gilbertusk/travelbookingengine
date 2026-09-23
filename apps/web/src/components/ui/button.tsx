import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/cn'

/**
 * Tombol.
 *
 * Empat varian, dan daftarnya tertutup — DESIGN-SYSTEM.md melarang menambah
 * varian baru. Batasan itu bukan kesewenangan: begitu ada enam varian, tidak
 * ada lagi yang dapat menebak mana yang "aksi utama", dan aksen kehilangan
 * artinya karena muncul di banyak tempat sekaligus.
 *
 * `primary` memakai warna aksen, dan aksen hanya boleh dipakai untuk satu
 * aksi utama per layar.
 */
const buttonVariants = cva(
  cn(
    'inline-flex items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap',
    'transition-colors duration-200 ease-[var(--ease-enter)]',
    'disabled:pointer-events-none disabled:opacity-50',
    '[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:pointer-events-none',
  ),
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/95',
        secondary: 'border border-border bg-card text-foreground hover:bg-muted active:bg-muted',
        ghost: 'text-foreground hover:bg-muted active:bg-muted',
        destructive:
          'bg-destructive text-destructive-foreground hover:bg-destructive/90 active:bg-destructive/95',
      },
      size: {
        // Ukuran sentuh minimal 44px pada perangkat sentuh. Pada penunjuk
        // presisi, tombol setinggi 44px di dalam tabel terasa terlalu besar —
        // jadi yang disesuaikan adalah perangkatnya, bukan aturannya.
        sm: 'h-9 px-3 text-small pointer-coarse:h-11',
        md: 'h-11 px-5 text-body',
        lg: 'h-12 px-6 text-body',
        icon: 'size-9 pointer-coarse:size-11',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
)

export type ButtonProps = ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    /** Merender elemen anak alih-alih <button>, misalnya sebuah tautan. */
    readonly asChild?: boolean
  }

export function Button({ className, variant, size, asChild, ...props }: ButtonProps) {
  const Component = asChild === true ? Slot.Root : 'button'

  return <Component className={cn(buttonVariants({ variant, size }), className)} {...props} />
}

export { buttonVariants }
