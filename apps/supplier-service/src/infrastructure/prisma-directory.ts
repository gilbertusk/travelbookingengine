import { SUPPLIER_CODES, type SupplierCode } from '@tbe/supplier-adapters'
import { DEFAULT_CIRCUIT_POLICY } from '../domain/circuit.js'
import { DEFAULT_RETRY_POLICY } from '../domain/retry-policy.js'
import type { PrismaClient, Supplier } from '../generated/prisma/client.js'
import type { SupplierDirectory, SupplierSettings } from '../application/ports.js'

/**
 * Konfigurasi supplier dari basis data.
 *
 * Kredensial TIDAK ada di sini. Tabel hanya menyimpan NAMA variabel env yang
 * memuatnya, dan nilainya dibaca saat perangkaian. Basis data yang bocor
 * tidak boleh sekaligus menjadi bocornya akses ke seluruh supplier.
 *
 * Dibaca pada setiap panggilan, bukan di-cache. Alasannya: operator yang
 * menonaktifkan supplier lewat endpoint operasi (FR-29) berharap perubahannya
 * berlaku sekarang, bukan setelah cache kedaluwarsa. Tabelnya berisi lima
 * baris — biayanya tidak sebanding dengan kebingungan yang ditimbulkan cache
 * yang basi.
 */

function isSupplierCode(value: string): value is SupplierCode {
  return (SUPPLIER_CODES as readonly string[]).includes(value)
}

function toSettings(row: Supplier): SupplierSettings | undefined {
  if (!isSupplierCode(row.code)) return undefined

  return {
    code: row.code,
    name: row.name,
    isActive: row.isActive,
    circuit: {
      failureThreshold: row.circuitFailureThreshold,
      windowMs: row.circuitWindowSeconds * 1_000,
      openDurationMs: row.circuitOpenSeconds * 1_000,
      successesToClose: DEFAULT_CIRCUIT_POLICY.successesToClose,
    },
    retry: DEFAULT_RETRY_POLICY,
  }
}

export function createPrismaDirectory(prisma: PrismaClient): SupplierDirectory {
  return {
    async list(): Promise<readonly SupplierSettings[]> {
      const rows = await prisma.supplier.findMany({ orderBy: { code: 'asc' } })

      return rows
        .map(toSettings)
        .filter((settings): settings is SupplierSettings => settings !== undefined)
    },

    async get(code: SupplierCode): Promise<SupplierSettings | undefined> {
      const row = await prisma.supplier.findUnique({ where: { code } })

      return row === null ? undefined : toSettings(row)
    },

    async update(code, patch): Promise<SupplierSettings | undefined> {
      const row = await prisma.supplier.findUnique({ where: { code } })
      if (row === null) return undefined

      const updated = await prisma.supplier.update({
        where: { code },
        data: {
          ...(patch.isActive === undefined ? {} : { isActive: patch.isActive }),
          ...(patch.circuit?.failureThreshold === undefined
            ? {}
            : { circuitFailureThreshold: patch.circuit.failureThreshold }),
          ...(patch.circuit?.windowMs === undefined
            ? {}
            : { circuitWindowSeconds: Math.round(patch.circuit.windowMs / 1_000) }),
          ...(patch.circuit?.openDurationMs === undefined
            ? {}
            : { circuitOpenSeconds: Math.round(patch.circuit.openDurationMs / 1_000) }),
        },
      })

      return toSettings(updated)
    },
  }
}
