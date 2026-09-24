import { SUPPLIER_CODES, type SupplierCode } from '../canonical/model.js'
import { createSupplierHttp, type SupplierHttp, type SupplierHttpConfig } from '../http/client.js'
import { createLunaAdapter } from '../adapters/luna.js'
import { createNovaAdapter } from '../adapters/nova.js'
import { createOrbitAdapter } from '../adapters/orbit.js'
import { createSkyAdapter } from '../adapters/sky.js'
import { createZephAdapter } from '../adapters/zeph.js'
import type { SupplierGateway } from '../ports/supplier-gateway.js'

/**
 * Registri adapter.
 *
 * Konfigurasi datang dari luar, tidak tertanam. Alamat supplier berbeda antara
 * pengembangan, staging, dan produksi, dan satu alamat yang tertulis di dalam
 * kode adalah alamat yang akan ikut terbawa ke produksi.
 */

type AdapterFactory = (http: SupplierHttp) => SupplierGateway

const FACTORIES: Readonly<Record<SupplierCode, AdapterFactory>> = {
  SKY: createSkyAdapter,
  NOVA: createNovaAdapter,
  ORBIT: createOrbitAdapter,
  LUNA: createLunaAdapter,
  ZEPH: createZephAdapter,
}

export type SupplierRegistryConfig = Readonly<Record<SupplierCode, SupplierHttpConfig>>

export interface SupplierRegistry {
  /** Adapter untuk satu supplier. Kode selalu dikenal — tipenya menjaminnya. */
  get(code: SupplierCode): SupplierGateway
  /** Seluruh adapter, untuk fan-out pencarian pada Step 13. */
  all(): readonly SupplierGateway[]
}

export function createSupplierRegistry(config: SupplierRegistryConfig): SupplierRegistry {
  const adapters = new Map<SupplierCode, SupplierGateway>(
    SUPPLIER_CODES.map((code) => [code, FACTORIES[code](createSupplierHttp(code, config[code]))]),
  )

  return {
    get(code: SupplierCode): SupplierGateway {
      const adapter = adapters.get(code)
      if (adapter === undefined) throw new Error(`Tidak ada adapter untuk supplier "${code}"`)

      return adapter
    },

    all(): readonly SupplierGateway[] {
      return [...adapters.values()]
    },
  }
}

/**
 * Konfigurasi untuk mock-supplier, yang menyajikan kelimanya di satu proses.
 *
 * Di dunia nyata setiap supplier punya host sendiri; di sini keduanya dibuat
 * setara lewat awalan path, sehingga kode adapter tidak perlu tahu bedanya.
 *
 * LUNA diberi kelonggaran waktu tersendiri karena memang lambat — p50-nya
 * sekitar 2,8 detik. Memaksanya ke batas waktu yang sama dengan SKY berarti
 * membuang seluruh hasil LUNA setiap kali, dan itu terlihat seperti supplier
 * yang mati padahal ia hanya lambat.
 */
export function mockSupplierRegistryConfig(baseUrl: string): SupplierRegistryConfig {
  return {
    SKY: { baseUrl: `${baseUrl}/sky` },
    NOVA: { baseUrl: `${baseUrl}/nova` },
    ORBIT: { baseUrl: `${baseUrl}/orbit` },
    LUNA: { baseUrl: `${baseUrl}/luna`, timeouts: { search: 6_000, priceCheck: 7_000 } },
    ZEPH: { baseUrl: `${baseUrl}/zeph` },
  }
}
