'use client'

import { QueryClientProvider } from '@tanstack/react-query'
import { ThemeProvider } from 'next-themes'
import { useState, type ReactNode } from 'react'
import { Toaster } from '@/components/ui/toaster'
import { createQueryClient } from '@/lib/query-client'

/**
 * Penyedia lintas aplikasi.
 *
 * QueryClient dibuat di dalam `useState`, bukan sebagai konstanta modul.
 * Konstanta modul di server dibagi antar permintaan, dan cache yang dibagi
 * antar permintaan berarti data satu pengguna dapat terlihat oleh pengguna
 * lain — kebocoran yang tidak muncul sama sekali saat pengembangan
 * satu-pengguna dan baru terlihat setelah rilis.
 */
export function Providers({ children }: { readonly children: ReactNode }) {
  const [queryClient] = useState(createQueryClient)

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider
        attribute="data-theme"
        defaultTheme="system"
        enableSystem
        // Transisi warna saat tema berganti membuat seluruh halaman berkedip;
        // pergantian tema seharusnya terasa seperti lampu ditekan, bukan
        // seperti halaman dimuat ulang.
        disableTransitionOnChange
      >
        {children}
        <Toaster />
      </ThemeProvider>
    </QueryClientProvider>
  )
}
