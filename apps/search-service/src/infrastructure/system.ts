import type { Deadline, DeadlineFactory } from '../application/fan-out.js'

/**
 * Anggaran waktu sungguhan, di atas `setTimeout`.
 *
 * Jembatan tipis dengan sengaja: seluruh keputusan tentang anggaran ada di
 * [fanOut], dan yang di sini hanya menerjemahkannya menjadi timer. Itu yang
 * membuat keputusannya dapat diuji tanpa satu milidetik pun benar-benar
 * berlalu.
 */
export const systemDeadline: DeadlineFactory = (budgetMs: number): Deadline => {
  let timer: NodeJS.Timeout | undefined

  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, budgetMs)
    // Timer anggaran tidak boleh menahan proses tetap hidup saat dimatikan.
    timer.unref()
  })

  return {
    expired,
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer)
    },
  }
}

export const systemClock = { now: () => Date.now() }
