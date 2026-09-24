import type { Metrics } from '@tbe/shared-kernel'
import type { SearchMetrics } from '../application/ports.js'

/**
 * Jembatan tipis ke prom-client.
 *
 * Nama dan label metriknya didaftarkan di shared-kernel, bukan di sini: nama
 * metrik adalah kontrak dengan dasbor dan alert, dan kontrak yang tersebar di
 * sepuluh service akan berbeda-beda ejaannya dalam hitungan minggu.
 */
export function createSearchMetrics(metrics: Metrics): SearchMetrics {
  return {
    cacheHit: (layer) => {
      metrics.domain.searchCacheHits.inc({ layer })
    },
    cacheMiss: (layer) => {
      metrics.domain.searchCacheMisses.inc({ layer })
    },
  }
}
