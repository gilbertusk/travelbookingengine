import { Router, type Response } from 'express'
import { pathParam } from './context.js'
import { z } from 'zod'
import { FAILURE_MODES, NEUTRAL_CHAOS, type ChaosRegistry } from '../application/chaos.js'
import {
  SCRIPTED_MODES,
  SUPPLIER_OPERATIONS,
  type FaultScript,
} from '../application/fault-script.js'
import type { OperationDeps } from '../application/ports.js'
import { reservationSnapshot } from '../application/reservation.js'
import { SUPPLIER_CODES, SUPPLIER_PROFILES, isSupplierCode } from '../domain/supplier.js'

/**
 * Panel kendali kegagalan.
 *
 * Inilah yang membuat seluruh mock supplier bernilai. Tanpa endpoint ini,
 * lima supplier tiruan hanyalah lima sumber data palsu; dengan endpoint ini,
 * mereka menjadi alat uji yang dapat membuktikan klaim ketahanan.
 *
 * Saat demonstrasi, endpoint inilah yang dipakai untuk mematikan satu supplier
 * di depan penilai lalu menunjukkan pencarian tetap berjalan.
 */

const latencySchema = z.object({
  min: z.number().int().min(0).max(120_000),
  max: z.number().int().min(0).max(120_000),
})

const failureSchema = z.object({
  rate: z.number().min(0).max(1),
  mode: z.enum(FAILURE_MODES).default('server_error'),
})

const driftSchema = z.object({ rate: z.number().min(0).max(1) })

const faultSchema = z.object({
  operation: z.enum(SUPPLIER_OPERATIONS),
  mode: z.enum(SCRIPTED_MODES),
  times: z.number().int().min(1).max(100).default(1),
})

export interface AdminRouterOptions {
  readonly chaos: ChaosRegistry
  readonly script: FaultScript
  readonly deps: OperationDeps
}

export function createAdminRouter(options: AdminRouterOptions): Router {
  const router = Router()

  registerGlobalRoutes(router, options)
  registerSupplierRoutes(router, options.chaos)
  registerScriptRoutes(router, options.script)

  return router
}

function registerGlobalRoutes(router: Router, options: AdminRouterOptions): void {
  const { chaos, script, deps } = options

  router.get('/state', (_req, res) => {
    res.json({
      suppliers: SUPPLIER_CODES.map((code) => ({
        code,
        profile: SUPPLIER_PROFILES[code],
        chaos: chaos.get(code),
        scripted: script.pending(code),
      })),
    })
  })

  router.post('/reset', (_req, res) => {
    // Jadwal ikut dibersihkan: kegagalan terjadwal yang tidak terpakai oleh
    // satu skenario tidak boleh menimpa skenario berikutnya.
    chaos.reset()
    script.clear()
    res.json({ reset: 'chaos', suppliers: SUPPLIER_CODES })
  })

  router.get('/reservations', (_req, res) => {
    res.json(reservationSnapshot(deps))
  })

  router.post('/inventory/reset', (_req, res) => {
    // Mengembalikan ketersediaan, hold, booking, dan pergeseran harga ke
    // keadaan awal. Dipakai di antara skenario uji beban agar setiap skenario
    // mulai dari titik yang sama.
    deps.store.reset()
    res.json({ reset: 'inventory' })
  })
}

function registerSupplierRoutes(router: Router, chaos: ChaosRegistry): void {
  router.param('supplier', (_req, res, next, value: string) => {
    if (!isSupplierCode(value.toUpperCase())) {
      res.status(404).json({ error: 'UNKNOWN_SUPPLIER', supplier: value })
      return
    }
    next()
  })

  router.post('/:supplier/latency', (req, res) => {
    const parsed = latencySchema.safeParse(req.body)
    if (!parsed.success || parsed.data.max < parsed.data.min) {
      res.status(400).json({ error: 'INVALID_RANGE' })
      return
    }

    apply(res, chaos, pathParam(req, 'supplier'), { latencyMs: [parsed.data.min, parsed.data.max] })
  })

  router.post('/:supplier/failure', (req, res) => {
    const parsed = failureSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_FAILURE', modes: FAILURE_MODES })
      return
    }

    apply(res, chaos, pathParam(req, 'supplier'), {
      failureRate: parsed.data.rate,
      failureMode: parsed.data.mode,
    })
  })

  router.post('/:supplier/price-drift', (req, res) => {
    const parsed = driftSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_RATE' })
      return
    }

    apply(res, chaos, pathParam(req, 'supplier'), { priceDriftRate: parsed.data.rate })
  })

  router.post('/:supplier/down', (req, res) => {
    apply(res, chaos, pathParam(req, 'supplier'), { down: true })
  })

  router.post('/:supplier/up', (req, res) => {
    // Menyalakan kembali mengembalikan supplier ke perilaku bawaan profilnya,
    // bukan hanya mematikan flag down. Suntikan yang tertinggal dari skenario
    // sebelumnya adalah penyebab umum uji berikutnya gagal tanpa sebab jelas.
    apply(res, chaos, pathParam(req, 'supplier'), NEUTRAL_CHAOS)
  })
}

function registerScriptRoutes(router: Router, script: FaultScript): void {
  router.post('/:supplier/faults', (req, res) => {
    const code = pathParam(req, 'supplier').toUpperCase()
    const parsed = faultSchema.safeParse(req.body)

    if (!isSupplierCode(code)) {
      res.status(404).json({ error: 'UNKNOWN_SUPPLIER' })
      return
    }
    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_FAULT', modes: SCRIPTED_MODES })
      return
    }

    res.json({ supplier: code, scripted: script.add(code, parsed.data) })
  })
}

function apply(
  res: Response,
  chaos: ChaosRegistry,
  supplier: string,
  changes: Parameters<ChaosRegistry['patch']>[1],
): void {
  const code = supplier.toUpperCase()

  if (!isSupplierCode(code)) {
    res.status(404).json({ error: 'UNKNOWN_SUPPLIER' })
    return
  }

  res.json({ supplier: code, chaos: chaos.patch(code, changes) })
}
