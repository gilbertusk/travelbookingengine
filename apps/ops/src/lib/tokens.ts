import { z } from 'zod'

/** Sepasang token dari auth-service, sebagaimana dijawab gateway. */
export const tokenPairSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresIn: z.number().int().positive(),
})

export type TokenPair = z.infer<typeof tokenPairSchema>

export interface SessionTokens {
  readonly accessToken?: string | undefined
  readonly refreshToken?: string | undefined
}

/** Isi `data` dari amplop gateway, atau undefined bila bentuknya lain. */
export function dataOf(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null || !('data' in payload)) return undefined
  return payload.data
}
