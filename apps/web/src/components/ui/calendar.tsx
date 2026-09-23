'use client'

import { ChevronLeft, ChevronRight } from 'lucide-react'
import { id as localeId } from 'date-fns/locale'
import type { ComponentProps } from 'react'
import { DayPicker } from 'react-day-picker'
import { cn } from '@/lib/cn'

/**
 * Kalender.
 *
 * Seluruh kelas bawaan react-day-picker diganti token kita — pustakanya
 * membawa stylesheet sendiri yang tidak tahu apa-apa tentang dark mode.
 *
 * Dua bulan berdampingan di desktop, satu bulan di mobile. Memaksa dua bulan
 * pada lebar 375px menghasilkan sel tanggal selebar 20px, dan tanggal yang
 * tidak dapat disentuh dengan akurat membuat pemilihan rentang gagal terus.
 *
 * Tanggal tidak tersedia ditandai dua cara — pudar DAN dicoret — karena warna
 * tidak boleh menjadi satu-satunya pembawa informasi.
 */
export function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: ComponentProps<typeof DayPicker>) {
  return (
    <DayPicker
      locale={localeId}
      showOutsideDays={showOutsideDays}
      className={cn('p-3', className)}
      classNames={{
        months: 'flex flex-col gap-6 sm:flex-row',
        month: 'flex flex-col gap-4',
        month_caption: 'flex h-9 items-center justify-center',
        caption_label: 'text-small font-medium',
        nav: 'flex items-center gap-1',
        button_previous: cn(
          'absolute left-3 inline-flex size-9 items-center justify-center rounded-md',
          'text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
          'disabled:pointer-events-none disabled:opacity-40',
        ),
        button_next: cn(
          'absolute right-3 inline-flex size-9 items-center justify-center rounded-md',
          'text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
          'disabled:pointer-events-none disabled:opacity-40',
        ),
        month_grid: 'w-full border-collapse',
        weekdays: 'flex',
        weekday: 'w-10 text-caption font-normal text-muted-foreground',
        week: 'mt-1 flex w-full',
        day: 'relative size-10 p-0 text-center',
        day_button: cn(
          'inline-flex size-10 items-center justify-center rounded-md text-small',
          'transition-colors duration-150 hover:bg-muted',
          'aria-selected:bg-primary aria-selected:text-primary-foreground',
        ),
        selected: 'bg-primary/10',
        range_middle: 'bg-primary/10 rounded-none',
        range_start: 'rounded-l-md',
        range_end: 'rounded-r-md',
        today: 'font-semibold underline underline-offset-4',
        outside: 'text-muted-foreground/50',
        disabled: 'text-muted-foreground/40 line-through',
        hidden: 'invisible',
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation }) =>
          orientation === 'left' ? (
            <ChevronLeft className="size-4" />
          ) : (
            <ChevronRight className="size-4" />
          ),
      }}
      {...props}
    />
  )
}
