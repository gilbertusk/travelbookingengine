import { NextResponse, type NextRequest } from 'next/server'
import { REFRESH_COOKIE } from '@/lib/session'

/**
 * Halaman panel tanpa sesi diarahkan ke /masuk.
 *
 * Hanya keberadaan cookie yang diperiksa — sama seperti apps/web. Keputusan
 * akhir tetap di gateway dan service; middleware hanya mencegah halaman
 * kosong dirender untuk pengunjung yang jelas belum masuk.
 */

export function proxy(request: NextRequest): NextResponse {
  const hasSession = request.cookies.has(REFRESH_COOKIE)
  const isLogin = request.nextUrl.pathname === '/masuk'

  if (!hasSession && !isLogin) return NextResponse.redirect(new URL('/masuk', request.url))
  if (hasSession && isLogin) return NextResponse.redirect(new URL('/', request.url))
  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
}
