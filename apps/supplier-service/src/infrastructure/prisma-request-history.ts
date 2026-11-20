import { SUPPLIER_CODES, type SupplierCode } from '@tbe/supplier-adapters'
import type { RequestHistory, RequestRecord, RequestSampleRow } from '../application/ports.js'
import type { PrismaClient } from '../generated/prisma/client.js'

/**
 * Pembacaan `supplier_requests` untuk panel operator (Step 27).
 *
 * `since` hanya memilih tiga kolom: muatan permintaan dan respons dapat
 * berukuran kilobita per baris, dan ribuan baris untuk menghitung persentil
 * tidak membutuhkannya. Kedua kueri dilayani indeks yang sudah ada —
 * `(supplier_code, created_at)` dan `idempotency_key`.
 *
 * Kode supplier yang tidak dikenal (baris dari supplier yang sudah dihapus
 * dari adapter) dibuang, bukan dipaksakan menjadi SupplierCode.
 */
export function createPrismaRequestHistory(prisma: PrismaClient): RequestHistory {
  return {
    async since(from, limit) {
      const rows = await prisma.supplierRequest.findMany({
        where: { createdAt: { gte: from } },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: { supplierCode: true, outcome: true, latencyMs: true },
      })

      return rows.flatMap((row): RequestSampleRow[] =>
        isSupplierCode(row.supplierCode)
          ? [{ supplier: row.supplierCode, outcome: row.outcome, latencyMs: row.latencyMs }]
          : [],
      )
    },

    async byIdempotencyKey(key, limit) {
      const rows = await prisma.supplierRequest.findMany({
        where: { idempotencyKey: key },
        orderBy: { createdAt: 'asc' },
        take: limit,
      })

      return rows.flatMap((row): RequestRecord[] =>
        isSupplierCode(row.supplierCode)
          ? [
              {
                id: row.id,
                supplier: row.supplierCode,
                operation: row.operation,
                outcome: row.outcome,
                errorKind: row.errorKind,
                attemptNumber: row.attemptNumber,
                latencyMs: row.latencyMs,
                requestPayload: row.requestPayload,
                responsePayload: row.responsePayload,
                createdAt: row.createdAt,
              },
            ]
          : [],
      )
    },
  }
}

function isSupplierCode(value: string): value is SupplierCode {
  return (SUPPLIER_CODES as readonly string[]).includes(value)
}
