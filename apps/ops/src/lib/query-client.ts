import { QueryClient } from '@tanstack/react-query'
import { OpsError } from './ops-client'

/**
 * Bawaan TanStack Query untuk panel operator.
 *
 * Berbeda dari apps/web: data operator SEHARUSNYA segar — `staleTime` nol dan
 * fokus jendela memicu pengambilan ulang. Operator yang kembali ke tab setelah
 * lima menit harus melihat keadaan pemutus sekarang, bukan lima menit lalu.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 0, refetchOnWindowFocus: true, retry: shouldRetry },
      // Mutasi operator — mematikan supplier, mengubah markup — tidak diulang
      // otomatis: mengulang "nonaktifkan" yang sebenarnya sudah berhasil
      // menjadi "aktifkan" pada tombol yang bergantian.
      mutations: { retry: false },
    },
  })
}

/** 4xx tidak berubah pada percobaan kedua; hanya galat jaringan dan 5xx yang diulang, sekali. */
export function shouldRetry(failureCount: number, error: Error): boolean {
  if (error instanceof OpsError && error.status < 500) return false
  return failureCount < 1
}
