'use client'

import { useQuery } from '@tanstack/react-query'
import { Alert, AlertDescription } from '@tbe/ui/alert'
import { Badge } from '@tbe/ui/badge'
import { count, milliseconds, percent } from '@/lib/format'
import { opsRequest } from '@/lib/ops-client'
import { CircuitBadge } from './circuit-badge'
import { CIRCUIT_OPERATIONS, supplierHealthListSchema } from './schema'

/**
 * Kesehatan supplier (FR-31), diperbarui setiap tiga detik — "secara
 * langsung" dalam arti yang dapat dipakai saat demo: supplier yang dimatikan
 * dari panel kendali terlihat berpindah ke pemutus TERBUKA dalam hitungan
 * detik, tanpa memuat ulang halaman.
 *
 * Polling, bukan SSE: panel dipakai satu-dua operator, dan tiga detik sudah
 * lebih cepat dari jendela pemutus mana pun. Aliran langsung menambah satu
 * jenis koneksi lagi yang harus diteruskan gateway tanpa membeli apa pun.
 */
export const HEALTH_REFRESH_MS = 3_000

export function SupplierHealthTable() {
  const health = useQuery({
    queryKey: ['ops', 'suppliers'],
    queryFn: async () => await opsRequest(supplierHealthListSchema, 'GET', '/suppliers'),
    refetchInterval: HEALTH_REFRESH_MS,
  })

  if (health.isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          Kesehatan supplier tidak dapat dibaca: {health.error.message}
        </AlertDescription>
      </Alert>
    )
  }
  if (health.data === undefined) return <p className="text-muted-foreground">Memuat…</p>

  const isTruncated = health.data.some((row) => row.window.isTruncated)

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto">
        <table className="w-full text-small">
          <caption className="sr-only">Kesehatan supplier per operasi</caption>
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="p-2">Supplier</th>
              {CIRCUIT_OPERATIONS.map((operation) => (
                <th key={operation} className="p-2">
                  {operation}
                </th>
              ))}
              <th className="p-2">Percobaan</th>
              <th className="p-2">Galat</th>
              <th className="p-2">p50</th>
              <th className="p-2">p95</th>
            </tr>
          </thead>
          <tbody>
            {health.data.map((row) => (
              <tr key={row.code} className="border-t">
                <td className="p-2 font-medium">
                  {row.code} {!row.isActive && <Badge variant="outline">nonaktif</Badge>}
                </td>
                {CIRCUIT_OPERATIONS.map((operation) => (
                  <td key={operation} className="p-2">
                    <CircuitBadge state={row.circuits[operation]} />
                  </td>
                ))}
                <td className="p-2" data-numeric>
                  {count(row.window.attempts)}
                </td>
                <td className="p-2" data-numeric>
                  {percent(row.window.attempts === 0 ? null : row.window.errorRateBasisPoints)}
                </td>
                <td className="p-2" data-numeric>
                  {milliseconds(row.window.latencyP50Ms)}
                </td>
                <td className="p-2" data-numeric>
                  {milliseconds(row.window.latencyP95Ms)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {isTruncated && (
        <p className="text-caption text-muted-foreground">
          Batas sampel tercapai: statistik dihitung dari percobaan terbaru saja.
        </p>
      )}
    </div>
  )
}
