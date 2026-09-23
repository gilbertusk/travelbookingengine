'use client'

import { Tabs as TabsPrimitive } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/cn'

export const Tabs = TabsPrimitive.Root

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn('inline-flex items-center gap-1 border-b border-border', className)}
      {...props}
    />
  )
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'relative -mb-px h-11 px-3 text-small font-medium text-muted-foreground',
        'transition-colors duration-200 ease-[var(--ease-enter)]',
        'hover:text-foreground',
        'disabled:pointer-events-none disabled:opacity-50',
        // Tab terpilih ditandai garis DAN perubahan warna teks: warna saja
        // tidak boleh menjadi satu-satunya pembawa informasi.
        'data-[state=active]:border-b-2 data-[state=active]:border-primary',
        'data-[state=active]:text-foreground',
        className,
      )}
      {...props}
    />
  )
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn('pt-6', className)} {...props} />
}
