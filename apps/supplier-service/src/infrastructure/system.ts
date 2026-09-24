import { setTimeout as delay } from 'node:timers/promises'
import type { Clock, Sleeper } from '../application/ports.js'

/**
 * Waktu sebagai ketergantungan, bukan sebagai global.
 *
 * `Date.now()` yang dipanggil langsung di dalam logika ketahanan membuat
 * seluruh perilaku berbasis waktu — jendela pemutus, backoff, pemulihan
 * bertahap — hanya dapat diuji dengan benar-benar menunggu. Pengujian yang
 * menunggu tiga puluh detik adalah pengujian yang akan dimatikan orang.
 */
export const systemClock: Clock = { now: () => Date.now() }

export const systemSleeper: Sleeper = {
  sleep: async (ms: number) => {
    await delay(ms)
  },
}
