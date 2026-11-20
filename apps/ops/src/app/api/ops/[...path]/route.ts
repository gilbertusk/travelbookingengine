import { cookies } from 'next/headers'
import { NextResponse, type NextRequest } from 'next/server'
import { serverConfig } from '@/config'
import { fetchGateway } from '@/lib/gateway'
import { forwardToOps, isSameOrigin, type OpsMethod } from '@/lib/ops-proxy'
import { applySession, sessionFrom } from '@/lib/session'

/**
 * Penerus `/api/ops/*` → gateway `/ops/*`. Keputusannya di lib/ops-proxy.ts;
 * berkas ini hanya merangkai Next dengan logika itu.
 */

type Context = { readonly params: Promise<{ readonly path: string[] }> }

async function handle(request: NextRequest, context: Context, method: OpsMethod) {
  const config = serverConfig()
  if (!isSameOrigin(method, request.headers.get('origin'), request.url)) {
    return NextResponse.json(
      { data: null, error: { code: 'FORBIDDEN', message: 'Asal permintaan tidak sah.' } },
      { status: 403 },
    )
  }

  const { path } = await context.params
  const body: unknown = method === 'GET' ? undefined : await request.json().catch(() => undefined)
  const result = await forwardToOps(fetchGateway(config.apiUrl), {
    method,
    segments: path,
    search: request.nextUrl.search,
    ...(body === undefined ? {} : { body }),
    tokens: sessionFrom(await cookies()),
  })

  const response = NextResponse.json(result.payload, { status: result.status })
  return applySession(response, result.session, { secure: config.secureCookies })
}

export async function GET(request: NextRequest, context: Context) {
  return await handle(request, context, 'GET')
}
export async function POST(request: NextRequest, context: Context) {
  return await handle(request, context, 'POST')
}
export async function PATCH(request: NextRequest, context: Context) {
  return await handle(request, context, 'PATCH')
}
export async function DELETE(request: NextRequest, context: Context) {
  return await handle(request, context, 'DELETE')
}
