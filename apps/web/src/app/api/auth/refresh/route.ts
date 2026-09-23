import { NextResponse } from 'next/server'
import { callGateway } from '@/lib/gateway'
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from '@/lib/session-cookie'

/**
 * Menukar refresh token dengan access token baru.
 *
 * auth-service merotasi refresh token pada setiap penukaran, jadi cookie
 * harus ikut diperbarui. Lupa memperbaruinya berarti penukaran kedua memakai
 * token yang sudah dipakai — dan auth-service memperlakukan pemakaian ulang
 * sebagai pencurian token, lalu mencabut seluruh keluarga sesi. Gejalanya:
 * pengguna terlempar keluar setiap beberapa menit tanpa sebab yang jelas.
 */
export async function POST(): Promise<NextResponse> {
  const refreshToken = await readRefreshCookie()

  if (refreshToken === undefined) {
    // 200, bukan 401. Pengunjung yang memang belum pernah masuk bukan
    // permintaan yang ditolak — dan membalas 401 di sini menaruh satu galat
    // merah di konsol setiap orang yang membuka beranda, sampai galat di
    // konsol berhenti berarti apa-apa.
    return NextResponse.json({ accessToken: null })
  }

  const result = await callGateway<{
    accessToken: string
    refreshToken: string
  }>('/auth/refresh', { method: 'POST', body: { refreshToken } })

  if (!result.ok || result.data === null) {
    // Cookie yang tidak lagi berlaku dibuang, supaya permintaan berikutnya
    // tidak mengulangi penukaran yang sudah pasti gagal.
    await clearRefreshCookie()
    return NextResponse.json({ error: { code: 'SESSION_EXPIRED' } }, { status: 401 })
  }

  await setRefreshCookie(result.data.refreshToken)

  return NextResponse.json({ accessToken: result.data.accessToken })
}
