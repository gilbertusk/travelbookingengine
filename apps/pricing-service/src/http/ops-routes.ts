import {
  NotFoundError,
  requireOperator,
  success,
  validate,
  type AppError,
} from '@tbe/shared-kernel'
import { moneySchema } from '@tbe/money'
import { SUPPLIER_CODES } from '@tbe/supplier-adapters'
import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import type { PricingDeps } from '../application/ports.js'
import { previewMarkupChange } from '../application/preview-markup.js'
import { MARKUP_KINDS } from '../domain/markup.js'
import type { MarkupChange } from '../domain/markup-preview.js'
import {
  createRuleBody,
  createRuleHandler,
  deleteRuleHandler,
  listRulesHandler,
  updateRuleBody,
  updateRuleHandler,
  validateRuleShape,
} from './pricing-routes.js'

/**
 * Rute panel operator untuk aturan markup (Step 27, FR-30).
 *
 * CRUD memakai handler yang SAMA dengan rute internal — satu aturan validasi,
 * satu jalan tulis. Yang baru hanya pratinjau.
 *
 * `requireOperator` dipasang untuk seluruh awalan, termasuk pratinjau yang
 * tidak menulis apa pun: pratinjau membuka aturan markup dan struktur harga,
 * dan itu bukan bacaan untuk pelanggan.
 */

/** Sampel pratinjau. Panel mengirim kombinasi kecil; ini bukan jalur penetapan harga massal. */
const MAX_PREVIEW_SAMPLES = 200

const ruleBody = z.object({
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
})

const previewBody = validate(
  z.object({
    change: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('create'), rule: ruleBody }),
      z.object({
        kind: z.literal('update'),
        id: z.string().min(1),
        patch: z.object({
          priority: z.number().int().min(-1_000).max(1_000).optional(),
          percentageBasisPoints: z.number().int().min(0).max(100_000).optional(),
          isActive: z.boolean().optional(),
        }),
      }),
      z.object({ kind: z.literal('deactivate'), id: z.string().min(1) }),
    ]),
    samples: z
      .array(
        z.object({
          ref: z.string().min(1).max(200),
          supplier: z.enum(SUPPLIER_CODES),
          city: z.string().min(1).max(120),
          supplierTotal: moneySchema,
        }),
      )
      .min(1)
      .max(MAX_PREVIEW_SAMPLES),
  }),
  'body',
)

const RULES = '/ops/pricing/markup-rules'

export function createOpsRouter(deps: PricingDeps): Router {
  const router = Router()

  router.use('/ops/pricing', requireOperator)
  router.get(RULES, listRulesHandler(deps))
  router.post(RULES, createRuleBody, createRuleHandler(deps))
  // Didaftarkan SEBELUM `/:id`: Express mencocokkan berurutan, dan
  // `preview` akan terbaca sebagai pengenal aturan.
  router.post(`${RULES}/preview`, previewBody, previewHandler(deps))
  router.patch(`${RULES}/:id`, updateRuleBody, updateRuleHandler(deps))
  router.delete(`${RULES}/:id`, deleteRuleHandler(deps))

  return router
}

function previewHandler(deps: PricingDeps): RequestHandler {
  return (_req, res, next) => {
    const body = previewBody.value(res)
    const shapeError = ruleShapeError(body.change)
    if (shapeError !== undefined) {
      next(shapeError)
      return
    }

    void previewMarkupChange(deps, toChange(body.change), body.samples).then((outcome) => {
      if (outcome.kind === 'rule_not_found') {
        next(new NotFoundError('aturan markup tidak ditemukan'))
        return
      }
      res.json(success(outcome))
    }, next)
  }
}

type ParsedChange = ReturnType<typeof previewBody.value>['change']

/** Sama dengan validasi saat membuat aturan: aturan yang tidak dapat diterapkan tidak dipratinjau. */
function ruleShapeError(change: ParsedChange): AppError | undefined {
  return change.kind === 'create' ? validateRuleShape(change.rule) : undefined
}

/** `exactOptionalPropertyTypes`: bidang opsional dari Zod dibuang bila tidak ada. */
function toChange(change: ParsedChange): MarkupChange {
  if (change.kind !== 'create') return change

  const { rule } = change
  return {
    kind: 'create',
    rule: {
      name: rule.name,
      priority: rule.priority,
      scope: {
        ...(rule.scope.supplier === undefined ? {} : { supplier: rule.scope.supplier }),
        ...(rule.scope.city === undefined ? {} : { city: rule.scope.city }),
      },
      kind: rule.kind,
      ...(rule.percentageBasisPoints === undefined
        ? {}
        : { percentageBasisPoints: rule.percentageBasisPoints }),
      ...(rule.fixedAmount === undefined ? {} : { fixedAmount: rule.fixedAmount }),
      isActive: rule.isActive,
    },
  }
}
