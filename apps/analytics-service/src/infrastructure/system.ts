import type { Clock } from '../application/ports.js'

/** Jam sesungguhnya. */
export const systemClock: Clock = {
  now: () => new Date(),
}
