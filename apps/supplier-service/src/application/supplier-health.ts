import type { SupplierCode } from '@tbe/supplier-adapters'
import type { CircuitState } from '../domain/circuit.js'
import { summarizeRequests, type RequestStats } from '../domain/request-stats.js'
import type {
  CircuitStore,
  Clock,
  RequestHistory,
  SupplierDirectory,
  SupplierSettings,
} from './ports.js'

/**
 * Kesehatan seluruh supplier untuk panel operator (FR-31).
 *
 * Keadaan pemutus dibaca untuk SETIAP operasi, bukan hanya `search` seperti
 * di `GET /internal/suppliers`. Operator yang menanyakan "kenapa pemesanan
 * gagal" perlu melihat pemutus `book` terbuka sementara pencarian sehat —
 * ringkasan satu keadaan per supplier menyembunyikan tepat kasus itu.
 *
 * `decide` dipakai, bukan pembacaan mentah, dengan alasan yang sama dengan
 * daftar internal: pemutus yang sudah melewati durasinya dilaporkan setengah
 * terbuka, bukan terbuka.
 */

/** Operasi yang punya pemutus sendiri — lihat supplier-operations.ts dan confirm-booking.ts. */
export const CIRCUIT_OPERATIONS = ['search', 'priceCheck', 'hold', 'book', 'cancel'] as const

export interface HealthDeps {
  readonly directory: SupplierDirectory
  readonly circuits: CircuitStore
  readonly history: RequestHistory
  readonly clock: Clock
}

export interface HealthWindow {
  readonly windowMs: number
  /**
   * Batas sampel. Saat uji beban, lima belas menit dapat berarti puluhan ribu
   * baris; yang terbaru saja sudah cukup untuk persentil yang bermakna, dan
   * panel tidak boleh menjadi kueri terberat di basis data.
   */
  readonly sampleLimit: number
}

export interface SupplierHealth {
  readonly code: SupplierCode
  readonly name: string
  readonly isActive: boolean
  readonly settings: SupplierSettings
  readonly circuits: Readonly<Record<(typeof CIRCUIT_OPERATIONS)[number], CircuitState>>
  readonly window: RequestStats & { readonly windowMs: number; readonly isTruncated: boolean }
}

export async function supplierHealth(
  deps: HealthDeps,
  window: HealthWindow,
): Promise<readonly SupplierHealth[]> {
  const now = deps.clock.now()
  const [settings, samples] = await Promise.all([
    deps.directory.list(),
    deps.history.since(new Date(now - window.windowMs), window.sampleLimit),
  ])
  const isTruncated = samples.length >= window.sampleLimit

  return await Promise.all(
    settings.map(async (supplier) => ({
      code: supplier.code,
      name: supplier.name,
      isActive: supplier.isActive,
      settings: supplier,
      circuits: await circuitStates(deps, supplier, now),
      window: {
        ...summarizeRequests(samples.filter((sample) => sample.supplier === supplier.code)),
        windowMs: window.windowMs,
        isTruncated,
      },
    })),
  )
}

async function circuitStates(
  deps: HealthDeps,
  supplier: SupplierSettings,
  now: number,
): Promise<SupplierHealth['circuits']> {
  const state = async (operation: (typeof CIRCUIT_OPERATIONS)[number]): Promise<CircuitState> =>
    (await deps.circuits.decide({ supplier: supplier.code, operation }, supplier.circuit, now))
      .state

  // Larik literal, bukan CIRCUIT_OPERATIONS.map: Promise.all atas tupel
  // mempertahankan posisi tiap operasi tanpa assertion tipe.
  const [search, priceCheck, hold, book, cancel] = await Promise.all([
    state('search'),
    state('priceCheck'),
    state('hold'),
    state('book'),
    state('cancel'),
  ])

  return { search, priceCheck, hold, book, cancel }
}
