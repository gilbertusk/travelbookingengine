import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, type RenderResult } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'

/**
 * Perkakas uji.
 *
 * QueryClient dibuat baru untuk setiap render, dan percobaan ulang dimatikan.
 * Tanpa keduanya, satu pengujian yang memuat data akan mengisi cache yang
 * terbawa ke pengujian berikutnya, dan kegagalan yang seharusnya langsung
 * terlihat justru tertunda dua kali percobaan ulang sampai pengujian habis
 * waktunya.
 */
export function renderWithQuery(ui: ReactElement): RenderResult {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  })

  function Wrapper({ children }: { readonly children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }

  return render(ui, { wrapper: Wrapper })
}
