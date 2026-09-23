import { NextResponse } from 'next/server'
import { callGateway } from '@/lib/gateway'
import { clearRefreshCookie, readRefreshCookie } from '@/lib/session-cookie'

/**
 * Keluar.
 *
 * Cookie dibuang apa pun hasil pencabutan di server. Kalau urutannya dibalik —
 * cookie hanya dibuang saat pencabutan berhasil — maka gateway yang sedang
 * tumbang membuat pengguna tidak dapat keluar sama sekali, dan itu keadaan
 * yang lebih buruk daripada sesi yang tercabut di satu sisi saja.
 */
export async function POST(): Promise<NextResponse> {
  const refreshToken = await readRefreshCookie()

  if (refreshToken !== undefined) {
    await callGateway('/auth/logout', { method: 'POST', body: { refreshToken } })
  }

  await clearRefreshCookie()

  return NextResponse.json({ ok: true })
}
