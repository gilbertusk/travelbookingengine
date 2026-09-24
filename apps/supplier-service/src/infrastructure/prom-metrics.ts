import { CIRCUIT_STATE_VALUES, type Metrics } from '@tbe/shared-kernel'
import type { SupplierCode } from '@tbe/supplier-adapters'
import type { CircuitState } from '../domain/circuit.js'
import type { SupplierMetrics } from '../application/ports.js'

/**
 * Jembatan ke metrik yang sudah didaftarkan shared-kernel.
 *
 * Nama dan label metrik didefinisikan di sana, bukan di sini, karena keduanya
 * adalah kontrak dengan dasbor dan alert — kontrak yang ditulis ulang di
 * sepuluh service akan berbeda ejaannya dalam hitungan minggu.
 */
export function createSupplierMetrics(metrics: Metrics): SupplierMetrics {
  return {
    observeRequest({ supplier, operation, outcome, seconds }) {
      metrics.domain.supplierRequestDuration.observe({ supplier, operation, outcome }, seconds)
    },

    setCircuitState(supplier: SupplierCode, operation: string, state: CircuitState) {
      metrics.domain.supplierCircuitState.set({ supplier, operation }, CIRCUIT_STATE_VALUES[state])
    },

    countRetry(supplier: SupplierCode, operation: string) {
      metrics.domain.supplierRetries.inc({ supplier, operation })
    },
  }
}
