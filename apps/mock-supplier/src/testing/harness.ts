import type { Express } from 'express'
import { createLogger } from '@tbe/shared-kernel'
import { buildMockSupplierApp } from '../composition/app.js'
import type { SupplierContext } from '../http/context.js'

/**
 * Perkakas uji. Tidak ikut ter-build — lihat exclude pada tsconfig.build.json.
 *
 * Jam dan sumber keacakan dapat dikendalikan sepenuhnya. Tanpa itu, pengujian
 * kedaluwarsa hold harus benar-benar menunggu lima belas menit, dan pengujian
 * pergeseran harga hanya bisa berharap keberuntungan.
 */

export interface Harness {
  readonly app: Express
  readonly context: SupplierContext
  advance(ms: number): void
  setRandom(value: number): void
}

export interface HarnessOptions {
  /** 0.99 secara bawaan: di atas seluruh peluang kegagalan dan pergeseran harga. */
  readonly random?: number
  readonly startMs?: number
  readonly holdTtlMs?: number
}

export const STAY = {
  checkIn: '2026-11-10',
  checkOut: '2026-11-12',
} as const

export function createHarness(options: HarnessOptions = {}): Harness {
  let nowMs = options.startMs ?? Date.parse('2026-09-23T10:00:00Z')
  let randomValue = options.random ?? 0.99

  const logger = createLogger({
    serviceName: 'mock-supplier-test',
    level: 'silent',
    destination: {
      write(): void {
        // keluaran log tidak diuji
      },
    },
  })

  const { app, context } = buildMockSupplierApp({
    logger,
    instant: true,
    random: () => randomValue,
    now: () => nowMs,
    holdTtlMs: options.holdTtlMs,
  })

  return {
    app,
    context,
    advance(ms) {
      nowMs += ms
    },
    setRandom(value) {
      randomValue = value
    },
  }
}
