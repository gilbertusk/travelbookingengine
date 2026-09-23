import { Separator as SeparatorPrimitive } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/cn'

/**
 * Pemisah.
 *
 * Alat utama untuk memisahkan bagian tanpa membuat kartu bersarang.
 * Bawaannya dekoratif, sehingga tidak ikut dibacakan pembaca layar sebagai
 * sesuatu yang bermakna.
 */
export function Separator({
  className,
  orientation = 'horizontal',
  decorative = true,
  ...props
}: ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      orientation={orientation}
      decorative={decorative}
      className={cn(
        'shrink-0 bg-border',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className,
      )}
      {...props}
    />
  )
}
