import { z } from 'zod'
import type { GatewayPort } from '@/lib/gateway'
import { dataOf, tokenPairSchema, type TokenPair } from '@/lib/tokens'

/**
 * Masuk ke panel operator.
 *
 * Akun pelanggan yang sah DITOLAK di sini, lebih awal, dengan pesan yang
 * jelas — dan sesinya langsung dicabut supaya tidak ada refresh token
 * pelanggan yang tertinggal di auth-service tanpa pemilik. Pemeriksaan ini
 * KENYAMANAN, bukan batas keamanan: pelanggan yang memalsukan respons ini pun
 * tetap ditolak gateway (403) dan service (`requireOperator`).
 */

export const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1).max(200),
})

export type Credentials = z.infer<typeof loginSchema>

const loginReplySchema = tokenPairSchema.extend({
  user: z.object({ email: z.string(), name: z.string(), role: z.string() }),
})

export type LoginOutcome =
  | { readonly kind: 'signed_in'; readonly tokens: TokenPair; readonly name: string }
  | { readonly kind: 'not_operator' }
  | { readonly kind: 'rejected'; readonly status: number; readonly payload: unknown }

export async function loginOperator(
  gateway: GatewayPort,
  credentials: Credentials,
): Promise<LoginOutcome> {
  const reply = await gateway.send({ method: 'POST', path: '/auth/login', body: credentials })
  const parsed = loginReplySchema.safeParse(dataOf(reply.payload))
  if (reply.status !== 200 || !parsed.success) {
    return {
      kind: 'rejected',
      status: reply.status === 200 ? 502 : reply.status,
      payload: reply.payload,
    }
  }

  const { user, ...tokens } = parsed.data
  if (user.role !== 'operator') {
    await gateway.send({
      method: 'POST',
      path: '/auth/logout',
      body: { refreshToken: tokens.refreshToken },
    })
    return { kind: 'not_operator' }
  }

  return { kind: 'signed_in', tokens, name: user.name }
}
