import type { Redis } from 'ioredis'
import type { SupplierCode } from '@tbe/supplier-adapters'
import {
  CLOSED_CIRCUIT,
  afterFailure,
  afterSuccess,
  decide,
  type CircuitDecision,
  type CircuitPolicy,
  type CircuitRecord,
  type CircuitState,
  type Transition,
} from '../domain/circuit.js'
import type { CircuitKey, CircuitStore } from '../application/ports.js'

/**
 * Keadaan pemutus di Redis.
 *
 * Inilah yang membuat penggandaan horizontal tidak membuat tiap instance
 * belajar sendiri-sendiri. Pemutus yang hitungannya per-proses berarti
 * sepuluh replika masing-masing harus menembak supplier yang sudah jelas
 * tumbang sebanyak lima kali sebelum berhenti — lima puluh panggilan sia-sia
 * ke sistem yang sedang berusaha bangkit.
 *
 * Pencatatan hasil dijalankan sebagai skrip Lua. Bukan demi kecepatan:
 * baca-ubah-tulis dari dua instance yang gagal bersamaan akan sama-sama
 * membaca hitungan lama, menulis nilai yang sama, dan ambang pemutus tidak
 * pernah tercapai. Lua membuat seluruh langkah berjalan sebagai satu operasi.
 *
 * Keputusannya sendiri tetap milik domain: skrip ini hanya menyimpan angka,
 * dan yang menghitung transisinya adalah fungsi murni yang sama dengan yang
 * dipakai implementasi dalam memori.
 */

const KEY_PREFIX = 'circuit'

/**
 * Baca-lalu-tulis bersyarat.
 *
 * Nilai ditulis hanya bila yang tersimpan masih sama dengan yang dibaca.
 * Kalau instance lain menulis lebih dulu, skrip mengembalikan keadaan
 * terbarunya dan pemanggil menghitung ulang — tanpa kehilangan hitungan.
 */
const COMPARE_AND_SET = `
local current = redis.call('GET', KEYS[1])
if current == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
  return 1
end
return 0
`

/** Percobaan ulang bila instance lain menulis lebih dulu. */
const MAX_CONTENTION_RETRIES = 5

function keyOf(key: CircuitKey): string {
  return `${KEY_PREFIX}:${key.supplier}:${key.operation}`
}

/**
 * Masa simpan catatan.
 *
 * Lebih panjang dari jendela dan durasi terbuka, supaya keadaan tidak hilang
 * tepat saat dibutuhkan. Cukup pendek supaya supplier yang sudah lama tidak
 * dipanggil tidak menyisakan hitungan basi yang membuka pemutus pada
 * panggilan pertama setelah berjam-jam diam.
 */
function ttlMs(policy: CircuitPolicy): number {
  return Math.max(policy.windowMs, policy.openDurationMs) * 4
}

function serialise(record: CircuitRecord): string {
  return JSON.stringify(record)
}

function parse(raw: string | null): CircuitRecord {
  if (raw === null) return CLOSED_CIRCUIT

  try {
    const parsed = JSON.parse(raw) as Partial<CircuitRecord>

    return {
      state: isState(parsed.state) ? parsed.state : 'closed',
      failures: numberOr(parsed.failures, 0),
      successes: numberOr(parsed.successes, 0),
      windowStartedAtMs: numberOr(parsed.windowStartedAtMs, 0),
      openedAtMs: numberOr(parsed.openedAtMs, 0),
    }
  } catch {
    // Catatan yang rusak diperlakukan sebagai pemutus tertutup. Menolak
    // panggilan karena satu nilai di cache tidak dapat diurai akan membuat
    // kerusakan kecil di Redis menjadi pemadaman menyeluruh.
    return CLOSED_CIRCUIT
  }
}

function isState(value: unknown): value is CircuitState {
  return value === 'closed' || value === 'open' || value === 'half_open'
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function createRedisCircuitStore(redis: Redis): CircuitStore {
  return {
    async decide(key: CircuitKey, policy: CircuitPolicy, nowMs: number): Promise<CircuitDecision> {
      return decide(parse(await redis.get(keyOf(key))), policy, nowMs)
    },

    async record(
      key: CircuitKey,
      outcome: 'success' | 'failure',
      policy: CircuitPolicy,
      nowMs: number,
    ): Promise<Transition> {
      const redisKey = keyOf(key)

      for (let attempt = 0; attempt < MAX_CONTENTION_RETRIES; attempt += 1) {
        const raw = await redis.get(redisKey)
        const current = parse(raw)

        const transition =
          outcome === 'success'
            ? afterSuccess(current, policy, nowMs)
            : afterFailure(current, policy, nowMs)

        const written = await redis.eval(
          COMPARE_AND_SET,
          1,
          redisKey,
          raw ?? serialise(CLOSED_CIRCUIT),
          serialise(transition.record),
          String(ttlMs(policy)),
        )

        if (written === 1) return transition
      }

      // Perebutan yang tidak selesai setelah lima percobaan berarti instance
      // lain sedang menulis terus-menerus — dan itu berarti keadaannya sudah
      // ditentukan mereka. Keadaan terakhir yang terbaca dikembalikan tanpa
      // transisi, supaya tidak ada peristiwa Kafka ganda.
      return { record: parse(await redis.get(redisKey)) }
    },
  }
}

/** Dipakai health check dan endpoint operasi untuk melihat keadaan. */
export async function readCircuitStates(
  redis: Redis,
  suppliers: readonly SupplierCode[],
  operations: readonly string[],
): Promise<Record<string, CircuitState>> {
  const entries: [string, CircuitState][] = []

  for (const supplier of suppliers) {
    for (const operation of operations) {
      const record = parse(await redis.get(keyOf({ supplier, operation })))
      entries.push([`${supplier}:${operation}`, record.state])
    }
  }

  return Object.fromEntries(entries)
}
