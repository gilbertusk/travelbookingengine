import { v7 as uuidv7 } from 'uuid'
import type { Clock } from '../application/ports.js'
import type { IdSource } from './prisma-notification-repository.js'

/** Jam dan pembuat pengenal yang sesungguhnya. */

export const systemClock: Clock = {
  now: () => new Date(),
}

/** UUID v7: terurut menurut waktu, ramah indeks B-tree. */
export const uuidSource: IdSource = {
  next: () => uuidv7(),
}
