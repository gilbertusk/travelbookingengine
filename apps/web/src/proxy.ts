import { NextResponse, type NextRequest } from 'next/server'

/**
 * Perlindungan rute privat.
 *
 * Berkas ini adalah `proxy.ts`, bukan `middleware.ts`: Next 16 mengganti nama
 * konvensinya, dan nama lama masih bekerja tetapi sudah ditandai usang.
 *
 * Yang diperiksa hanya keberadaan cookie sesi, bukan keabsahannya. Itu
 * disengaja: memverifikasi tanda tangan token di middleware berarti Edge
 * runtime harus memegang rahasia penandatanganan, dan rahasia itu sudah
 * dipegang dua tempat — menambah tempat ketiga menambah permukaan kebocoran
 * tanpa menambah keamanan.
 *
 * Keputusan akhir tetap di gateway, yang memang memverifikasi setiap
 * permintaan. Middleware hanya mencegah halaman privat sempat dirender untuk
 * pengunjung yang jelas-jelas belum masuk.
 */

const REFRESH_COOKIE = 'tbe_refresh'

const PRIVATE_PREFIXES = ['/bookings', '/account']

/** Halaman yang tidak masuk akal dibuka saat sudah masuk. */
const GUEST_ONLY_PATHS = ['/masuk', '/daftar']

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl
  const hasSession = request.cookies.has(REFRESH_COOKIE)

  if (!hasSession && PRIVATE_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    const url = new URL('/masuk', request.url)
    // Tujuan semula dibawa serta supaya pengguna kembali ke tempat yang ia
    // tuju setelah masuk, bukan terdampar di beranda.
    // Termasuk kuerinya: alur pemesanan membawa pilihan kamar di URL, dan
    // pengguna yang baru masuk harus kembali ke kamar yang sama (Step 21).
    url.searchParams.set('lanjut', `${pathname}${request.nextUrl.search}`)

    return NextResponse.redirect(url)
  }

  if (hasSession && GUEST_ONLY_PATHS.includes(pathname)) {
    return NextResponse.redirect(new URL('/', request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
}
