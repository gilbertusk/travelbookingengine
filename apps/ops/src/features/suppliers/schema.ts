import { z } from 'zod'

/** Bentuk jawaban `/ops/suppliers` (supplier-service, Step 27). */

export const CIRCUIT_STATES = ['closed', 'open', 'half_open'] as const
export const CIRCUIT_OPERATIONS = ['search', 'priceCheck', 'hold', 'book', 'cancel'] as const

const circuitState = z.enum(CIRCUIT_STATES)

export const supplierHealthSchema = z.object({
  code: z.string(),
  name: z.string(),
  isActive: z.boolean(),
  settings: z.object({
    circuit: z.object({
      failureThreshold: z.number(),
      windowMs: z.number(),
      openDurationMs: z.number(),
    }),
  }),
  circuits: z.object({
    search: circuitState,
    priceCheck: circuitState,
    hold: circuitState,
    book: circuitState,
    cancel: circuitState,
  }),
  window: z.object({
    attempts: z.number(),
    failures: z.number(),
    errorRateBasisPoints: z.number(),
    latencyP50Ms: z.number().nullable(),
    latencyP95Ms: z.number().nullable(),
    windowMs: z.number(),
    isTruncated: z.boolean(),
  }),
})

export type SupplierHealth = z.infer<typeof supplierHealthSchema>

export const supplierHealthListSchema = z.array(supplierHealthSchema)

export const supplierRequestSchema = z.object({
  id: z.string(),
  supplier: z.string(),
  operation: z.string(),
  outcome: z.enum(['success', 'failure']),
  errorKind: z.string().nullable(),
  attemptNumber: z.number(),
  latencyMs: z.number(),
  requestPayload: z.unknown(),
  responsePayload: z.unknown(),
  createdAt: z.string(),
})

export type SupplierRequest = z.infer<typeof supplierRequestSchema>
