'use client'

import { X } from 'lucide-react'
import { Dialog as SheetPrimitive } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/cn'

/**
 * Sheet — panel yang meluncur dari tepi layar.
 *
 * Dibangun di atas primitif Dialog karena perilakunya memang dialog: mengunci
 * fokus, menutup dengan Escape, dan menyembunyikan sisa halaman dari pembaca
 * layar. Yang berbeda hanya posisinya.
 *
 * Sisi `bottom` adalah bentuk yang dipakai filter di mobile — lembar bawah,
 * bukan menu bertumpuk.
 */
export const Sheet = SheetPrimitive.Root
export const SheetTrigger = SheetPrimitive.Trigger
export const SheetClose = SheetPrimitive.Close

const SIDE_CLASSES = {
  right: 'inset-y-0 right-0 h-full w-full max-w-sm border-l',
  left: 'inset-y-0 left-0 h-full w-full max-w-sm border-r',
  bottom: 'inset-x-0 bottom-0 max-h-[85vh] rounded-t-xl border-t',
  top: 'inset-x-0 top-0 max-h-[85vh] rounded-b-xl border-b',
} as const

export type SheetSide = keyof typeof SIDE_CLASSES

export function SheetContent({
  className,
  children,
  side = 'right',
  ...props
}: ComponentProps<typeof SheetPrimitive.Content> & { readonly side?: SheetSide }) {
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay
        className={cn(
          'fixed inset-0 z-50 bg-foreground/25 backdrop-blur-[2px]',
          'transition-opacity duration-200',
        )}
      />
      <SheetPrimitive.Content
        className={cn(
          'fixed z-50 flex flex-col gap-4 border-border bg-popover p-6 shadow-float',
          'transition-transform duration-200 ease-[var(--ease-enter)]',
          SIDE_CLASSES[side],
          className,
        )}
        {...props}
      >
        {children}
        <SheetPrimitive.Close
          className={cn(
            'absolute right-4 top-4 rounded-sm p-1 text-muted-foreground',
            'transition-colors hover:bg-muted hover:text-foreground',
          )}
        >
          <X className="size-4" />
          <span className="sr-only">Tutup</span>
        </SheetPrimitive.Close>
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  )
}

export function SheetHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1 pr-8', className)} {...props} />
}

export function SheetTitle({ className, ...props }: ComponentProps<typeof SheetPrimitive.Title>) {
  return <SheetPrimitive.Title className={cn('text-h3 font-medium', className)} {...props} />
}

export function SheetDescription({
  className,
  ...props
}: ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      className={cn('text-small text-muted-foreground', className)}
      {...props}
    />
  )
}

export function SheetFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('mt-auto flex flex-col gap-3 pt-4', className)} {...props} />
}
