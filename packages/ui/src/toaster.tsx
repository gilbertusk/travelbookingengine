'use client'

import { useTheme } from 'next-themes'
import { Toaster as Sonner, toast } from 'sonner'
import type { ComponentProps } from 'react'

/**
 * Notifikasi sementara.
 *
 * Sonner sudah menempatkan notifikasinya di wilayah `aria-live`, sehingga
 * perubahan yang tidak terlihat tetap diumumkan. Yang disesuaikan di sini
 * hanya warnanya — supaya memakai token kita, bukan palet bawaan pustakanya
 * yang tidak tahu apa-apa tentang dark mode.
 *
 * Toast hanya untuk hal yang boleh terlewat. Kegagalan yang menghentikan
 * pekerjaan pengguna ditampilkan di halaman lewat [ErrorState], bukan lewat
 * pesan yang menghilang sendiri setelah empat detik.
 */
export function Toaster(props: ComponentProps<typeof Sonner>) {
  const { resolvedTheme } = useTheme()

  return (
    <Sonner
      theme={resolvedTheme === 'dark' ? 'dark' : 'light'}
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast:
            'group rounded-lg border border-border bg-popover text-popover-foreground shadow-float',
          description: 'text-muted-foreground',
          actionButton: 'bg-primary text-primary-foreground',
          cancelButton: 'bg-muted text-muted-foreground',
          error: 'border-destructive/35',
          success: 'border-success/35',
          warning: 'border-warning/35',
        },
      }}
      {...props}
    />
  )
}

export { toast }
