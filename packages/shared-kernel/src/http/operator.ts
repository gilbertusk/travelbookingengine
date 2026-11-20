import type { RequestHandler } from 'express'
import { ForbiddenError, UnauthorizedError } from '../errors/app-error.js'

/**
 * Pemeriksaan peran operator DI SERVICE (Step 27).
 *
 * api-gateway sudah menolak bukan-operator untuk setiap awalan `/ops`. Service
 * tetap memeriksa lagi, dan itu bukan kehati-hatian ganda yang mubazir:
 * gateway hanya satu jalan masuk. Service yang dapat dihubungi dari jaringan
 * internal — oleh service lain yang disusupi, oleh salah konfigurasi ingress,
 * oleh port yang terbuka di mesin pengembang — tidak boleh menjawab rute
 * operator hanya karena permintaannya tidak lewat gateway.
 *
 * Header yang dibaca di sini aman dipercaya karena gateway MEMBUANG setiap
 * header `x-tbe-*` kiriman klien sebelum memasang identitas hasil verifikasi
 * (api-gateway/src/domain/identity.ts). Permintaan yang tidak lewat gateway
 * tidak membawa header ini sama sekali, dan ditolak 401.
 *
 * Alternatif yang ditolak: memverifikasi JWT di setiap service. Itu memaksa
 * sembilan service memegang rahasia penandatanganan — keputusan Step 08 justru
 * membatasinya pada gateway dan auth-service.
 */

export const USER_ID_HEADER = 'x-tbe-user-id'
export const USER_ROLE_HEADER = 'x-tbe-user-role'

export const USER_ROLES = ['customer', 'operator'] as const
export type UserRole = (typeof USER_ROLES)[number]

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value)
}

/**
 * Tanpa identitas sama sekali → 401: permintaan tidak lewat gateway, atau
 * tanpa token. Identitas ada tetapi bukan operator → 403. Keduanya dibedakan
 * supaya panel operator dapat mengarahkan ke halaman masuk hanya pada yang
 * pertama.
 */
export const requireOperator: RequestHandler = (req, _res, next) => {
  const userId = req.header(USER_ID_HEADER)
  if (userId === undefined || userId.length === 0) {
    next(new UnauthorizedError())
    return
  }

  if (req.header(USER_ROLE_HEADER) !== 'operator') {
    next(new ForbiddenError('Hanya operator yang dapat mengakses rute ini'))
    return
  }

  next()
}
