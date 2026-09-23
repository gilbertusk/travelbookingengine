import { QueryClient } from '@tanstack/react-query'
import { ApiError } from './api-error'

/**
 * Nilai bawaan TanStack Query.
 *
 * Bawaan pustakanya dirancang untuk aplikasi yang datanya berubah setiap
 * detik. Data di sini tidak: hasil pencarian punya masa berlaku, dan detail
 * properti hampir tidak pernah berubah dalam satu sesi. Mengambil ulang
 * setiap kali jendela difokuskan hanya menambah beban ke lima supplier tanpa
 * menghasilkan informasi baru.
 */

const ONE_MINUTE_MS = 60_000
const MAX_RETRIES = 2

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: ONE_MINUTE_MS,
        gcTime: 5 * ONE_MINUTE_MS,
        refetchOnWindowFocus: false,
        retry: shouldRetry,
      },
      mutations: {
        // Mutasi tidak pernah diulang otomatis. Permintaan yang mungkin sudah
        // dikerjakan server — pemesanan, pembayaran — tidak boleh dikirim dua
        // kali hanya karena responsnya tidak sampai.
        retry: false,
      },
    },
  })
}

/**
 * Mengulang hanya yang masuk akal diulang.
 *
 * Token kedaluwarsa dan masukan yang salah tidak akan berubah hasilnya pada
 * percobaan kedua; mengulangnya hanya menunda pesan galat yang sudah benar.
 * Yang layak diulang adalah kegagalan jaringan dan galat server sementara.
 */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_RETRIES) return false
  if (!(error instanceof ApiError)) return false

  return error.kind === 'network' || error.kind === 'server'
}
