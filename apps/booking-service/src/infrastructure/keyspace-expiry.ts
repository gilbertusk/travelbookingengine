import type { Logger, ManagedResource } from '@tbe/shared-kernel'
import type { Redis } from 'ioredis'
import { bookingIdOfExpiredKey } from './redis-hold-store.js'

/**
 * Pendengar kedaluwarsa hold lewat keyspace notification Redis (FR-16).
 *
 * Jalur CEPAT, bukan jalur yang dapat diandalkan. Redis mengirim notifikasi
 * sekali, kepada pelanggan yang terhubung saat itu, tanpa antrian. Pelanggan
 * yang sedang menyambung ulang kehilangannya untuk selamanya — itulah kenapa
 * penyapu berkala ada, dan kenapa keduanya memanggil use case yang sama.
 */

/** Huruf flag yang dibutuhkan: E (keyevent) dan x (expired), atau A yang memuat x. */
export function notifiesExpiry(flags: string): boolean {
  return flags.includes('E') && (flags.includes('x') || flags.includes('A'))
}

export interface ExpiryListenerOptions {
  /** Koneksi pelanggan. Koneksi dalam mode subscribe tidak dapat dipakai untuk perintah lain. */
  readonly subscriber: Redis
  /** Koneksi biasa, untuk memeriksa konfigurasi. */
  readonly commands: Redis
  readonly database: number
  readonly logger: Logger
  readonly onExpired: (bookingId: string) => Promise<void>
}

export function expiryListener(options: ExpiryListenerOptions): ManagedResource {
  const channel = `__keyevent@${String(options.database)}__:expired`

  return {
    name: 'hold-expiry-listener',
    start: async () => {
      await warnWhenDisabled(options)

      options.subscriber.on('message', (received: string, key: string) => {
        if (received !== channel) return
        const bookingId = bookingIdOfExpiredKey(key)
        if (bookingId === undefined) return

        // Kegagalan satu pelepasan tidak boleh mematikan pendengar untuk hold
        // lainnya. Dicatat dengan tingkat warn, bukan error: penyapu akan
        // mengulanginya, dan tidak ada tindakan manusia yang dibutuhkan.
        options.onExpired(bookingId).catch((error: unknown) => {
          options.logger.warn({ err: error, bookingId }, 'pelepasan hold lewat keyspace gagal')
        })
      })

      await options.subscriber.subscribe(channel)
    },
    stop: async () => {
      await options.subscriber.unsubscribe(channel)
    },
  }
}

/**
 * Redis tanpa notifikasi kedaluwarsa tidak menggagalkan startup: penyapu tetap
 * melepaskan hold, hanya lebih lambat. Tetapi ia dicatat, karena kalau tidak,
 * satu-satunya gejalanya adalah hold yang terlepas beberapa puluh detik
 * terlambat — dan tidak ada yang akan mencarinya.
 */
async function warnWhenDisabled(options: ExpiryListenerOptions): Promise<void> {
  const reply = await options.commands.config('GET', 'notify-keyspace-events')
  const flags = Array.isArray(reply) && typeof reply[1] === 'string' ? reply[1] : ''

  if (!notifiesExpiry(flags)) {
    options.logger.warn(
      { flags },
      'notify-keyspace-events tidak memuat Ex; hold hanya dilepas oleh penyapu',
    )
  }
}
