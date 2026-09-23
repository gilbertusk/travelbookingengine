import { NextResponse } from 'next/server'
import { callGateway, gatewayErrorResponse } from '@/lib/gateway'
import { setRefreshCookie } from '@/lib/session-cookie'
import { registerSchema } from '@/features/auth/types'

export async function POST(request: Request): Promise<NextResponse> {
  const parsed = registerSchema.safeParse(await request.json().catch(() => null))

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          // Pesan per-bidang sudah ditampilkan formulir di peramban. Yang
          // sampai ke sini hanya permintaan yang melewati formulir itu.
          message: 'Data pendaftaran tidak lengkap atau tidak sesuai.',
        },
      },
      { status: 400 },
    )
  }

  const result = await callGateway<{
    user: unknown
    accessToken: string
    refreshToken: string
  }>('/auth/register', { method: 'POST', body: parsed.data })

  if (!result.ok || result.data === null) return gatewayErrorResponse(result)

  await setRefreshCookie(result.data.refreshToken)

  return NextResponse.json({ user: result.data.user, accessToken: result.data.accessToken })
}
