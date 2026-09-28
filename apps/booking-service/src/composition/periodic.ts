import type { Logger, ManagedResource } from '@tbe/shared-kernel'

/**
 * Pekerjaan berkala sebagai sumber daya terkelola — penyapu hold (Step 17),
 * penyapu saga, dan penerbit outbox (Step 19).
 *
 * Putaran berikutnya dijadwalkan SETELAH putaran sebelumnya selesai, bukan
 * dengan `setInterval`: putaran yang lebih lama dari selangnya — basis data
 * lambat, ribuan hold kedaluwarsa sekaligus setelah pemadaman — tidak boleh
 * bertumpuk dengan putaran berikutnya. Seluruh pekerjaan di sini idempoten,
 * jadi tumpukan itu tidak merusak apa pun; tetapi ia juga tidak mempercepat
 * apa pun dan hanya menambah beban pada saat yang paling tidak tepat.
 */

export interface PeriodicOptions {
  readonly name: string
  readonly intervalMs: number
  readonly logger: Logger
  /** Pesan log bila satu putaran gagal. */
  readonly failure: string
  /**
   * Jalankan satu putaran DI DALAM `start`, sebelum sumber daya berikutnya
   * dinyalakan. Dipakai penyapu saga: saga yang tertinggal dipulihkan sebelum
   * HTTP menerima permintaan baru.
   */
  readonly runOnStart?: boolean
  /**
   * Satu putaran. Mengembalikan `true` bila masih ada pekerjaan tersisa —
   * outbox yang batch-nya penuh — dan putaran berikutnya dijalankan segera.
   */
  tick(): Promise<boolean>
}

export function periodicResource(options: PeriodicOptions): ManagedResource {
  let timer: NodeJS.Timeout | undefined
  let running: Promise<void> | undefined
  let stopped = false

  const once = async (): Promise<boolean> => {
    try {
      return await options.tick()
    } catch (error) {
      // Satu putaran yang gagal tidak menghentikan pekerjaan berkala. Tingkat
      // error: ketiga pekerjaan ini jaring pengaman atau jalur terbit, dan yang
      // terus gagal berarti hold, saga, atau pesan menumpuk tanpa ada yang
      // mengerjakannya.
      options.logger.error({ err: error, job: options.name }, options.failure)
      return false
    }
  }

  const loop = async (): Promise<void> => {
    const more = await once()
    if (!stopped) timer = setTimeout(schedule, more ? 0 : options.intervalMs)
  }

  const schedule = (): void => {
    running = loop()
  }

  return {
    name: options.name,
    start: async () => {
      const more = options.runOnStart === true ? await once() : false
      timer = setTimeout(schedule, more ? 0 : options.intervalMs)
    },
    stop: async () => {
      stopped = true
      clearTimeout(timer)
      await running
    },
  }
}
