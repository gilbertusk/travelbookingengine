import { NextResponse, type NextRequest } from 'next/server'
import { serverConfig } from '@/config'
import { loginOperator, loginSchema } from '@/features/auth/login'
import { fetchGateway } from '@/lib/gateway'
import { isSameOrigin } from '@/lib/ops-proxy'
import { withTokens } from '@/lib/session'

/** Masuk: token disimpan di cookie httpOnly, tidak dikembalikan ke halaman. */
export async function POST(request: NextRequest) {
  const config = serverConfig()
  if (!isSameOrigin('POST', request.headers.get('origin'), request.url)) {
    return error(403, 'FORBIDDEN', 'Asal permintaan tidak sah.')
  }

  const parsed = loginSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return error(400, 'VALIDATION_ERROR', 'Surel atau kata sandi tidak sah.')

  const outcome = await loginOperator(fetchGateway(config.apiUrl), parsed.data)
  if (outcome.kind === 'not_operator') {
    return error(403, 'NOT_OPERATOR', 'Akun ini bukan akun operator.')
  }
  if (outcome.kind === 'rejected') {
    return NextResponse.json(outcome.payload, { status: outcome.status })
  }

  return withTokens(
    NextResponse.json({ data: { name: outcome.name }, error: null }),
    outcome.tokens,
    {
      secure: config.secureCookies,
    },
  )
}

function error(status: number, code: string, message: string) {
  return NextResponse.json({ data: null, error: { code, message } }, { status })
}
