import { v7 as uuidv7 } from 'uuid'
import type { PrismaClient } from '../generated/prisma/client.js'
import type { RequestLog, RequestLogEntry } from '../application/ports.js'

/**
 * Pencatatan percobaan ke basis data.
 *
 * Setiap percobaan menjadi barisnya sendiri, bukan memperbarui baris pertama.
 * Riwayat percobaan itulah yang dibaca saat menelusuri pemesanan yang
 * statusnya tidak pasti: tanpa baris kedua, tidak ada cara mengetahui bahwa
 * `book` pernah kehabisan waktu sebelum akhirnya berhasil.
 *
 * Kegagalan mencatat TIDAK menggagalkan panggilan ke supplier. Pemesanan yang
 * berhasil lalu dibatalkan karena barisnya gagal ditulis adalah kerugian yang
 * jauh lebih besar daripada satu catatan yang hilang.
 */
export function createPrismaRequestLog(
  prisma: PrismaClient,
  onError: (error: unknown) => void,
): RequestLog {
  return {
    async record(entry: RequestLogEntry) {
      try {
        await prisma.supplierRequest.create({
          data: {
            id: uuidv7(),
            supplierCode: entry.supplier,
            operation: entry.operation as 'search',
            outcome: entry.outcome,
            errorKind: entry.errorKind ?? null,
            attemptNumber: entry.attemptNumber,
            latencyMs: entry.latencyMs,
            requestPayload: (entry.requestPayload ?? null) as object,
            responsePayload: (entry.responsePayload ?? null) as object,
            idempotencyKey: entry.idempotencyKey ?? null,
            correlationId: entry.correlationId ?? null,
          },
        })
      } catch (error) {
        onError(error)
      }
    },
  }
}
