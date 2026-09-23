import { SUPPLIER_CODES, SUPPLIER_PROFILES, type SupplierCode } from '../domain/supplier.js'

/**
 * Panel kendali kegagalan.
 *
 * Bagian terpenting dari seluruh mock supplier. Tanpa kemampuan membuat
 * supplier gagal sesuai kehendak, uji beban pada Step 15, uji konkurensi pada
 * Step 22, dan uji chaos pada Step 28 tidak membuktikan apa pun — dan seluruh
 * angka di README hanya akan menggambarkan sistem dalam keadaan sehat, yaitu
 * keadaan yang paling tidak menarik.
 */

export const FAILURE_MODES = [
  'timeout',
  'server_error',
  'unavailable',
  'connection_reset',
  'malformed',
  'truncated',
] as const

export type FailureMode = (typeof FAILURE_MODES)[number]

export interface SupplierChaos {
  /** Menimpa latensi bawaan profil. */
  readonly latencyMs: readonly [number, number] | undefined
  /** Menimpa peluang kegagalan bawaan profil. */
  readonly failureRate: number | undefined
  readonly failureMode: FailureMode
  readonly down: boolean
  /** Menimpa peluang pergeseran harga bawaan profil. */
  readonly priceDriftRate: number | undefined
}

export const NEUTRAL_CHAOS: SupplierChaos = {
  latencyMs: undefined,
  failureRate: undefined,
  failureMode: 'server_error',
  down: false,
  priceDriftRate: undefined,
}

export function isFailureMode(value: string): value is FailureMode {
  return (FAILURE_MODES as readonly string[]).includes(value)
}

export function latencyFor(code: SupplierCode, chaos: SupplierChaos, random: () => number): number {
  const [min, max] = chaos.latencyMs ?? SUPPLIER_PROFILES[code].latencyMs
  return Math.round(min + random() * Math.max(max - min, 0))
}

/**
 * Mengembalikan mode kegagalan bila permintaan ini harus gagal.
 *
 * Keputusannya memakai keacakan sungguhan, bukan fungsi deterministik atas isi
 * permintaan. Kalau permintaan yang sama selalu gagal, percobaan ulang tidak
 * pernah bisa berhasil, dan seluruh kebijakan retry pada Step 11 tidak dapat
 * diuji sama sekali.
 */
export function failureFor(
  code: SupplierCode,
  chaos: SupplierChaos,
  random: () => number,
): FailureMode | undefined {
  if (chaos.down) return 'connection_reset'

  const rate = chaos.failureRate ?? SUPPLIER_PROFILES[code].failureRate
  return random() < rate ? chaos.failureMode : undefined
}

export function shouldDriftPrice(
  code: SupplierCode,
  chaos: SupplierChaos,
  random: () => number,
): boolean {
  return random() < (chaos.priceDriftRate ?? SUPPLIER_PROFILES[code].priceDriftRate)
}

export interface ChaosRegistry {
  get(code: SupplierCode): SupplierChaos
  patch(code: SupplierCode, changes: Partial<SupplierChaos>): SupplierChaos
  reset(): void
  snapshot(): Readonly<Record<SupplierCode, SupplierChaos>>
}

export function createChaosRegistry(): ChaosRegistry {
  const state = new Map<SupplierCode, SupplierChaos>()

  const get = (code: SupplierCode): SupplierChaos => state.get(code) ?? NEUTRAL_CHAOS

  return {
    get,
    patch(code, changes) {
      const next: SupplierChaos = { ...get(code), ...changes }
      state.set(code, next)
      return next
    },
    reset() {
      state.clear()
    },
    snapshot() {
      return Object.fromEntries(SUPPLIER_CODES.map((code) => [code, get(code)])) as Record<
        SupplierCode,
        SupplierChaos
      >
    },
  }
}
