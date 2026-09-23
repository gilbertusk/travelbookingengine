import { NextResponse } from 'next/server'
import { callGateway, gatewayErrorResponse } from '@/lib/gateway'
import { setRefreshCookie } from '@/lib/session-cookie'
import { loginSchema } from '@/features/auth/types'

/**
 * Masuk.
 *
 * Rute ini ada demi satu hal: memisahkan refresh token dari JavaScript
 * halaman. Gateway mengembalikan sepasang token; yang panjang umurnya disimpan
 * ke cookie httpOnly di sini, dan hanya yang pendek umurnya yang diserahkan
 * ke peramban.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const parsed = loginSchema.safeParse(await request.json().catch(() => null))

  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Surel atau kata sandi tidak lengkap.' } },
      { status: 400 },
    )
  }

  const result = await callGateway<{
    user: unknown
    accessToken: string
    refreshToken: string
  }>('/auth/login', { method: 'POST', body: parsed.data })

  if (!result.ok || result.data === null) return gatewayErrorResponse(result)

  await setRefreshCookie(result.data.refreshToken)

  return NextResponse.json({ user: result.data.user, accessToken: result.data.accessToken })
}
