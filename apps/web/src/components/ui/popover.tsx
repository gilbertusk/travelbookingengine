'use client'

import { Popover as PopoverPrimitive } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/cn'

export const Popover = PopoverPrimitive.Root
export const PopoverTrigger = PopoverPrimitive.Trigger
export const PopoverAnchor = PopoverPrimitive.Anchor

export function PopoverContent({
  className,
  align = 'start',
  sideOffset = 8,
  ...props
}: ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          // Benar-benar melayang, jadi inilah salah satu dari sedikit tempat
          // yang boleh memakai bayangan.
          'z-50 rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-float',
          'transition-opacity duration-200 ease-[var(--ease-enter)]',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}
