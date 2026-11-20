'use client'

import { QueryClientProvider } from '@tanstack/react-query'
import { ThemeProvider } from 'next-themes'
import { useState, type ReactNode } from 'react'
import { createQueryClient } from '@/lib/query-client'

/** QueryClient di dalam useState — alasan yang sama dengan apps/web/src/components/providers.tsx. */
export function Providers({ children }: { readonly children: ReactNode }) {
  const [queryClient] = useState(createQueryClient)

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider
        attribute="data-theme"
        defaultTheme="system"
        enableSystem
        disableTransitionOnChange
      >
        {children}
      </ThemeProvider>
    </QueryClientProvider>
  )
}
