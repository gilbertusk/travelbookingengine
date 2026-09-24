import { AppError, NotFoundError, success, validate } from '@tbe/shared-kernel'
import { moneySchema } from '@tbe/money'
import { SUPPLIER_CODES } from '@tbe/supplier-adapters'
import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import { priceRatePlans } from '../application/price-rate-plans.js'
import type { PricingDeps } from '../application/ports.js'
import { MARKUP_KINDS } from '../domain/markup.js'

/**
 * Antarmuka internal.
 *
 * Dipakai search-service dan booking-service. Rute aturan markup juga di sini
 * dan dilindungi peran operator di api-gateway — bukan di sini, karena tidak
 * satu pun rute ini terdaftar sebagai rute publik.
 */

/**
 * Batas jumlah rate plan dalam satu panggilan.
 *
 * Ada batasnya, dan batasnya besar. Pencarian di satu kota dengan lima
 * supplier menghasilkan ratusan rate plan; menolak di bawah itu akan
 * memaksa pemanggil memecah permintaan, dan pemecahan itu justru
 * mengembalikan kueri berulang yang ingin dihindari.
 */
const MAX_RATE_PLANS = 2_000

const priceBody = validate(
  z.object({
    items: z
      .array(
        z.object({
          ref: z.string().min(1).max(200),
          supplier: z.enum(SUPPLIER_CODES),
          city: z.string().min(1).max(120),
          supplierTotal: moneySchema,
        }),
      )
      .min(1)
      .max(MAX_RATE_PLANS),
  }),
  'body',
)

const createRuleBody = validate(
  z.object({
    name: z.string().min(1).max(120),
    priority: z.number().int().min(-1_000).max(1_000).default(0),
    scope: z
      .object({
        supplier: z.enum(SUPPLIER_CODES).optional(),
        city: z.string().min(1).max(120).optional(),
      })
      .default({}),
    kind: z.enum(MARKUP_KINDS),
    percentageBasisPoints: z.number().int().min(0).max(100_000).optional(),
    fixedAmount: moneySchema.optional(),
    isActive: z.boolean().default(true),
  }),
  'body',
)

const updateRuleBody = validate(
  z.object({
    name: z.string().min(1).max(120).optional(),
    priority: z.number().int().min(-1_000).max(1_000).optional(),
    percentageBasisPoints: z.number().int().min(0).max(100_000).optional(),
    isActive: z.boolean().optional(),
  }),
  'body',
)

export function createPricingRouter(deps: PricingDeps): Router {
  const router = Router()

  router.post('/internal/pricing/rate-plans', priceBody, priceHandler(deps))
  router.get('/internal/pricing/rates', ratesHandler(deps))

  router.get('/internal/pricing/markup-rules', listRulesHandler(deps))
  router.post('/internal/pricing/markup-rules', createRuleBody, createRuleHandler(deps))
  router.patch('/internal/pricing/markup-rules/:id', updateRuleBody, updateRuleHandler(deps))
  router.delete('/internal/pricing/markup-rules/:id', deleteRuleHandler(deps))

  return router
}

/**
 * Menetapkan harga untuk sekumpulan rate plan.
 *
 * Item yang gagal dikembalikan bersama yang berhasil, bukan menggagalkan
 * seluruh panggilan: satu kurs yang hilang untuk satu supplier tidak boleh
 * menghapus hasil dari empat supplier lain.
 */
function priceHandler(deps: PricingDeps): RequestHandler {
  return (_req, res, next) => {
    const { items } = priceBody.value(res)

    void priceRatePlans(deps, items).then((run) => {
      res.json(
        success({
          priced: run.results.filter((result) => result.ok),
          failed: run.results.filter((result) => !result.ok),
          ratesUsed: run.ratesUsed,
        }),
      )
    }, next)
  }
}

function ratesHandler(deps: PricingDeps): RequestHandler {
  return (_req, res, next) => {
    void deps.rates.current().then((rates) => {
      res.json(success(rates))
    }, next)
  }
}

function listRulesHandler(deps: PricingDeps): RequestHandler {
  return (_req, res, next) => {
    void deps.markupRules.listAll().then((rules) => {
      res.json(success(rules))
    }, next)
  }
}

function createRuleHandler(deps: PricingDeps): RequestHandler {
  return (_req, res, next) => {
    const body = createRuleBody.value(res)

    const invalid = validateRuleShape(body)
    if (invalid !== undefined) {
      next(invalid)
      return
    }

    void deps.markupRules
      .create({
        name: body.name,
        priority: body.priority,
        scope: body.scope,
        kind: body.kind,
        ...(body.percentageBasisPoints === undefined
          ? {}
          : { percentageBasisPoints: body.percentageBasisPoints }),
        ...(body.fixedAmount === undefined ? {} : { fixedAmount: body.fixedAmount }),
        isActive: body.isActive,
      })
      .then((rule) => {
        res.status(201).json(success(rule))
      }, next)
  }
}

/**
 * Aturan persentase tanpa angka persentasenya, atau aturan nominal tanpa
 * nominalnya, adalah aturan yang tidak dapat diterapkan. Ditolak saat dibuat,
 * bukan diam-diam menjadi "tanpa markup" saat dipakai.
 */
function validateRuleShape(body: {
  kind: string
  percentageBasisPoints?: number | undefined
  fixedAmount?: unknown
}): AppError | undefined {
  if (body.kind === 'percentage' && body.percentageBasisPoints === undefined) {
    return new AppError({
      code: 'VALIDATION_ERROR',
      httpStatus: 400,
      message: 'aturan persentase membutuhkan percentageBasisPoints',
    })
  }

  if (body.kind === 'fixed' && body.fixedAmount === undefined) {
    return new AppError({
      code: 'VALIDATION_ERROR',
      httpStatus: 400,
      message: 'aturan nominal tetap membutuhkan fixedAmount',
    })
  }

  return undefined
}

function updateRuleHandler(deps: PricingDeps): RequestHandler {
  return (req, res, next) => {
    const id = String(req.params.id)

    void deps.markupRules.update(id, updateRuleBody.value(res)).then((rule) => {
      if (rule === undefined) {
        next(new NotFoundError(`aturan markup ${id} tidak ditemukan`))
        return
      }

      res.json(success(rule))
    }, next)
  }
}

function deleteRuleHandler(deps: PricingDeps): RequestHandler {
  return (req, res, next) => {
    const id = String(req.params.id)

    void deps.markupRules.remove(id).then((removed) => {
      if (!removed) {
        next(new NotFoundError(`aturan markup ${id} tidak ditemukan`))
        return
      }

      // Dinonaktifkan, bukan dihapus — harga pemesanan lama merujuknya.
      res.json(success({ id, isActive: false }))
    }, next)
  }
}
