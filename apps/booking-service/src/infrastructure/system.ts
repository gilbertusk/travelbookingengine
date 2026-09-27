import { randomUUID } from 'node:crypto'
import type { Clock, IdFactory } from '../application/ports.js'

/** Jam dan pembangkit pengenal sungguhan. Jembatan tipis; tidak ada keputusan di sini. */

export const systemClock: Clock = {
  now: () => new Date(),
}

export const uuidFactory: IdFactory = {
  next: () => randomUUID(),
}
