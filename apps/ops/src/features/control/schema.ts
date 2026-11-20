import { z } from 'zod'

/** `GET /ops/mock-supplier/state` — jawaban mentah mock supplier (bukan amplop). */

export const FAILURE_MODES = [
  'timeout',
  'server_error',
  'unavailable',
  'connection_reset',
  'malformed',
  'truncated',
] as const

export const mockStateSchema = z.object({
  suppliers: z.array(
    z.object({
      code: z.string(),
      chaos: z.object({
        down: z.boolean(),
        failureRate: z.number().optional(),
        failureMode: z.enum(FAILURE_MODES),
        latencyMs: z.tuple([z.number(), z.number()]).optional(),
        priceDriftRate: z.number().optional(),
      }),
    }),
  ),
})

export type MockSupplier = z.infer<typeof mockStateSchema>['suppliers'][number]
