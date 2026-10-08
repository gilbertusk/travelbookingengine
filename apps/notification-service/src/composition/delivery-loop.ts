import type { Logger, ManagedResource } from '@tbe/shared-kernel'

/**
 * Putaran penghantar sebagai sumber daya terkelola, dengan tombol bangun.
 *
 * Polanya sama dengan pekerjaan berkala booking-service (composition/
 * periodic.ts): putaran berikutnya dijadwalkan SETELAH putaran sebelumnya
 * selesai, tidak pernah bertumpuk. Bedanya satu: `wake()`. Pemberitahuan
 * yang baru dicatat tidak perlu menunggu selang penuh — consumer
 * membangunkan penghantar, dan surel biasanya berangkat dalam milidetik.
 *
 * Bangun di tengah putaran tidak memulai putaran kedua yang berpacu; ia
 * menandai bahwa satu putaran lagi harus dijalankan segera sesudahnya.
 */

export interface DeliveryLoopOptions {
  readonly intervalMs: number
  readonly logger: Logger
  /** Satu putaran. Mengembalikan jumlah pekerjaan yang dikerjakan. */
  tick(): Promise<number>
  /** Ukuran batch. Putaran yang penuh berarti mungkin masih ada sisa. */
  readonly batchSize: number
}

export interface DeliveryLoop extends ManagedResource {
  start(): Promise<void>
  stop(): Promise<void>
  wake(): void
}

export function deliveryLoop(options: DeliveryLoopOptions): DeliveryLoop {
  let timer: NodeJS.Timeout | undefined
  let running: Promise<void> | undefined
  let isStopped = false
  // Objek, bukan `let`: tanda ini diubah `wake()` SELAGI putaran menunggu,
  // dan penyempitan tipe pada variabel lokal tidak tahu itu.
  const signal = { isAwakened: false }

  const once = async (): Promise<boolean> => {
    try {
      return (await options.tick()) >= options.batchSize
    } catch (error) {
      // Galat di sini hanya galat basis data service ini sendiri — kegagalan
      // kirim sudah menjadi catatan di dalam putaran. Putaran berikutnya
      // mencoba lagi; sewa baris memulihkan pemberitahuan yang tertinggal.
      options.logger.error({ err: error }, 'putaran penghantar pemberitahuan gagal')
      return false
    }
  }

  const schedule = (delayMs: number): void => {
    clearTimeout(timer)
    if (isStopped) return
    timer = setTimeout(() => {
      running = loop()
    }, delayMs)
  }

  const loop = async (): Promise<void> => {
    const hasMore = await once()
    running = undefined
    const wasAwakened = signal.isAwakened
    signal.isAwakened = false
    schedule(hasMore || wasAwakened ? 0 : options.intervalMs)
  }

  return {
    name: 'delivery-loop',
    wake() {
      if (running === undefined) schedule(0)
      else signal.isAwakened = true
    },
    start: async () => {
      schedule(0)
      await Promise.resolve()
    },
    stop: async () => {
      isStopped = true
      clearTimeout(timer)
      await running
    },
  }
}
