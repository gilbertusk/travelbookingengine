import { randomUUID } from 'node:crypto'
import type { Clock } from '../application/ports.js'

export const systemClock: Clock = {
  now: () => Date.now(),
}

/**
 * Pengenal hold dan booking. Sengaja tidak deterministik: dua permintaan hold
 * yang identik harus menghasilkan dua hold berbeda, karena keduanya memang
 * menahan unit yang berbeda.
 */
export function newRef(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 20)}`
}

export const systemRandom = (): number => Math.random()
