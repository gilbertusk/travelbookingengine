import type { Redis } from 'ioredis'
import type { AcquireOutcome, HoldClaim, HoldEntry, HoldStore } from '../application/ports.js'

/**
 * Hold lokal di Redis.
 *
 * Tata letak kunci, per slot (rate plan + rentang tanggal):
 *
 *   booking:hold:cap:<slot>       kapasitas slot, dari ketersediaan pencarian
 *   booking:hold:members:<slot>   SET pengenal pemesanan yang memegang kursi
 *   booking:hold:lock:<id>        kunci waktu per hold; kedaluwarsanya = heldUntil
 *   booking:hold:slots            HASH pengenal → slot, untuk penyapu yatim
 *
 * Kursi yang terpakai adalah ANGGOTA set, bukan angka yang dikurangi. Angka
 * yang dikurangi harus dikembalikan tepat sekali, dan "tepat sekali" di antara
 * dua jalur pelepasan adalah persis masalah yang ingin dihindari. Dengan set,
 * pelepasan kedua untuk pemesanan yang sama adalah SREM yang tidak menghapus
 * apa-apa.
 *
 * Kunci waktu per hold ada supaya kedaluwarsanya memicu keyspace notification
 * `expired` — satu kunci, satu notifikasi, satu pemesanan. Nilainya slot,
 * tetapi notifikasi tidak membawa nilai; slot juga disimpan di hash.
 */

const PREFIX = 'booking:hold:'
export const LOCK_PREFIX = `${PREFIX}lock:`
const SLOTS_KEY = `${PREFIX}slots`

/**
 * Umur kapasitas slot. Kapasitas diambil dari ketersediaan yang terlihat
 * pengguna saat mencari, dan angka itu menua. Setelah umur ini, permintaan
 * berikutnya menetapkannya ulang dari pencarian yang lebih baru. Lapis supplier
 * tetap otoritas terakhir — lapis lokal mencegah perebutan, bukan menggantikan
 * inventaris supplier.
 */
export const SLOT_CAPACITY_TTL_MS = 30 * 60 * 1_000

const capKey = (slot: string) => `${PREFIX}cap:${slot}`
const membersKey = (slot: string) => `${PREFIX}members:${slot}`
const lockKey = (bookingId: string) => `${LOCK_PREFIX}${bookingId}`

/**
 * Pemeriksaan dan pengurangan dalam SATU skrip.
 *
 * Redis menjalankan skrip Lua secara atomik: tidak ada perintah lain yang
 * disela di antara SCARD dan SADD. Itulah satu-satunya alasan skrip ini ada.
 * Versi baca-lalu-tulis — SCARD dari klien, lalu SADD dari klien — memberi
 * seratus permintaan serentak kesempatan yang sama untuk melihat "masih ada
 * tempat", dan tests/integration membuktikannya terhadap Redis sungguhan.
 *
 * Kapasitas ditetapkan hanya bila belum ada (SET tanpa menimpa): permintaan
 * berikutnya tidak dapat menaikkan kapasitas slot dengan mengaku melihat
 * ketersediaan yang lebih besar.
 */
const ACQUIRE = `
if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1 then
  return 'already_held'
end
local capacity = tonumber(redis.call('GET', KEYS[1]))
if capacity == nil then
  capacity = tonumber(ARGV[2])
  redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[5])
end
if redis.call('SCARD', KEYS[2]) >= capacity then
  return 'sold_out'
end
redis.call('SADD', KEYS[2], ARGV[1])
redis.call('SET', KEYS[3], ARGV[4], 'PXAT', ARGV[3])
redis.call('HSET', KEYS[4], ARGV[1], ARGV[4])
return 'held'
`

/**
 * Pelepasan idempoten. Mengembalikan 1 hanya untuk pemanggil yang benar-benar
 * mengeluarkan pemesanan dari slot.
 */
const RELEASE = `
local removed = redis.call('SREM', KEYS[1], ARGV[1])
redis.call('DEL', KEYS[2])
redis.call('HDEL', KEYS[3], ARGV[1])
return removed
`

const ACQUIRE_OUTCOMES: readonly AcquireOutcome[] = ['held', 'already_held', 'sold_out']

export function createRedisHoldStore(redis: Redis): HoldStore {
  return {
    async acquire(claim: HoldClaim): Promise<AcquireOutcome> {
      const outcome = await redis.eval(
        ACQUIRE,
        4,
        capKey(claim.slot),
        membersKey(claim.slot),
        lockKey(claim.bookingId),
        SLOTS_KEY,
        claim.bookingId,
        String(claim.capacity),
        String(claim.until.getTime()),
        claim.slot,
        String(SLOT_CAPACITY_TTL_MS),
      )

      const known = ACQUIRE_OUTCOMES.find((candidate) => candidate === outcome)
      if (known === undefined) throw new Error(`skrip hold mengembalikan ${String(outcome)}`)

      return known
    },

    async shorten(bookingId: string, until: Date): Promise<void> {
      // LT: hanya bila lebih awal dari kedaluwarsa sekarang. Tidak ada jalan
      // memundurkan kedaluwarsa hold lewat operasi ini.
      await redis.pexpireat(lockKey(bookingId), until.getTime(), 'LT')
    },

    async release(entry: HoldEntry): Promise<boolean> {
      const removed = await redis.eval(
        RELEASE,
        3,
        membersKey(entry.slot),
        lockKey(entry.bookingId),
        SLOTS_KEY,
        entry.bookingId,
      )

      return removed === 1
    },

    async orphans(limit: number): Promise<readonly HoldEntry[]> {
      return await scanOrphans(redis, limit)
    },
  }
}

/**
 * Kursi yang kunci waktunya sudah hilang.
 *
 * Tidak atomik terhadap pengambilan hold baru, dan tidak perlu: pengambilan
 * menulis anggota, kunci waktu, dan entri hash dalam satu skrip, jadi tidak ada
 * saat di mana entri hash terlihat tanpa kunci waktunya. Entri yang ditemukan
 * di sini benar-benar kehilangan kunci waktunya.
 */
async function scanOrphans(redis: Redis, limit: number): Promise<readonly HoldEntry[]> {
  const found: HoldEntry[] = []
  let cursor = '0'

  do {
    const [next, flat] = await redis.hscan(SLOTS_KEY, cursor, 'COUNT', limit)
    cursor = next

    const entries = pairs(flat)
    const alive = await Promise.all(
      entries.map(async (entry) => await redis.exists(lockKey(entry.bookingId))),
    )

    entries.forEach((entry, index) => {
      if (alive[index] === 0 && found.length < limit) found.push(entry)
    })
  } while (cursor !== '0' && found.length < limit)

  return found
}

function pairs(flat: readonly string[]): HoldEntry[] {
  const entries: HoldEntry[] = []

  for (let index = 0; index + 1 < flat.length; index += 2) {
    entries.push({ bookingId: flat[index] ?? '', slot: flat[index + 1] ?? '' })
  }

  return entries
}

/**
 * Pengenal pemesanan dari nama kunci yang kedaluwarsa, atau `undefined` untuk
 * kunci yang bukan milik hold. Satu kanal `expired` membawa kedaluwarsa SEMUA
 * kunci di basis data Redis ini, termasuk milik service lain.
 */
export function bookingIdOfExpiredKey(key: string): string | undefined {
  return key.startsWith(LOCK_PREFIX) ? key.slice(LOCK_PREFIX.length) : undefined
}
