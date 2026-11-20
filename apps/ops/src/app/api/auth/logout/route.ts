import { cookies } from 'next/headers'
import { NextResponse, type NextRequest } from 'next/server'
import { serverConfig } from '@/config'
import { fetchGateway } from '@/lib/gateway'
import { isSameOrigin } from '@/lib/ops-proxy'
import { sessionFrom, withoutSession } from '@/lib/session'

/** Keluar: refresh token dicabut di auth-service, lalu cookie dihapus. */
export async function POST(request: NextRequest) {
  const config = serverConfig()
  if (!isSameOrigin('POST', request.headers.get('origin'), request.url)) {
    return NextResponse.json({ data: null, error: { code: 'FORBIDDEN' } }, { status: 403 })
  }

  const { refreshToken } = sessionFrom(await cookies())
  if (refreshToken !== undefined) {
    await fetchGateway(config.apiUrl).send({
      method: 'POST',
      path: '/auth/logout',
      body: { refreshToken },
    })
  }

  return withoutSession(NextResponse.json({ data: { signedOut: true }, error: null }), {
    secure: config.secureCookies,
  })
}
