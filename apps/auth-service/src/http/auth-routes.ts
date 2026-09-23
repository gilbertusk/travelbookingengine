import {
  ConflictError,
  RateLimitedError,
  UnauthorizedError,
  ValidationError,
  success,
  type Logger,
} from '@tbe/shared-kernel'
import { Router, type RequestHandler, type Response } from 'express'
import { authenticateUser } from '../application/authenticate-user.js'
import { getProfile, revokeSession, updateProfile } from '../application/manage-session.js'
import type { AuthDeps, IssuedTokens } from '../application/ports.js'
import { refreshSession } from '../application/refresh-session.js'
import { registerUser, type RegisterFailure } from '../application/register-user.js'
import { toPublicUser, type User } from '../domain/user.js'
import { authenticatedUser, createAuthenticationMiddleware } from './authenticate.js'
import { loginBody, refreshBody, registerBody, updateProfileBody } from './schemas.js'

/**
 * Rute autentikasi.
 *
 * Factory hanya mendaftarkan; setiap rute punya pabrik handler sendiri — pola
 * yang ditetapkan pada Step 04 dan berlaku untuk seluruh service.
 */

export interface AuthRouterOptions {
  readonly deps: AuthDeps
  readonly logger: Logger
}

export function createAuthRouter(options: AuthRouterOptions): Router {
  const router = Router()
  const requireUser = createAuthenticationMiddleware(options.deps.tokens)

  router.post('/register', registerBody, registerHandler(options))
  router.post('/login', loginBody, loginHandler(options))
  router.post('/refresh', refreshBody, refreshHandler(options))
  router.post('/logout', refreshBody, logoutHandler(options))
  router.get('/me', requireUser, profileHandler(options))
  router.patch('/me', requireUser, updateProfileBody, updateProfileHandler(options))

  return router
}

function registerHandler({ deps }: AuthRouterOptions): RequestHandler {
  return (_req, res, next) => {
    void registerUser(deps, registerBody.value(res)).then((result) => {
      if (!result.ok) {
        next(registerFailureToError(result.error))
        return
      }

      res.status(201).json(success(sessionPayload(result.value.user, result.value.tokens)))
    }, next)
  }
}

function loginHandler({ deps, logger }: AuthRouterOptions): RequestHandler {
  return (_req, res, next) => {
    void authenticateUser(deps, loginBody.value(res)).then((result) => {
      if (!result.ok) {
        if (result.error.kind === 'too_many_attempts') {
          logger.warn('percobaan masuk diblokir karena terlalu sering gagal')
          next(new RateLimitedError('Terlalu banyak percobaan masuk. Coba lagi nanti.'))
          return
        }

        // Pesan yang sama untuk surel tidak terdaftar dan kata sandi salah.
        // Membedakannya memberi tahu penyerang akun mana yang ada.
        next(new UnauthorizedError('Surel atau kata sandi salah'))
        return
      }

      res.json(success(sessionPayload(result.value.user, result.value.tokens)))
    }, next)
  }
}

function refreshHandler({ deps, logger }: AuthRouterOptions): RequestHandler {
  return (_req, res, next) => {
    void refreshSession(deps, refreshBody.value(res)).then((result) => {
      if (!result.ok) {
        if (result.error.familyRevoked) {
          // Pemakaian ulang refresh token berarti dua pihak memegang token yang
          // sama. Ini peristiwa keamanan, bukan sekadar permintaan yang ditolak.
          logger.warn(
            { reason: result.error.reason },
            'refresh token dipakai ulang, seluruh keluarga sesi dicabut',
          )
        }

        next(new UnauthorizedError('Sesi tidak berlaku. Silakan masuk kembali.'))
        return
      }

      res.json(success(tokenPayload(result.value)))
    }, next)
  }
}

function logoutHandler({ deps }: AuthRouterOptions): RequestHandler {
  return (_req, res, next) => {
    void revokeSession(deps, refreshBody.value(res).refreshToken).then((outcome) => {
      // Keluar selalu berhasil dari sudut pandang pemanggil. Membedakan
      // "token tidak ditemukan" dari "berhasil dicabut" hanya memberi cara
      // menebak token mana yang masih hidup.
      res.json(success({ outcome }))
    }, next)
  }
}

function profileHandler({ deps }: AuthRouterOptions): RequestHandler {
  return (_req, res, next) => {
    void getProfile(deps, authenticatedUser(res).id).then((result) => {
      if (!result.ok) {
        next(new UnauthorizedError())
        return
      }

      res.json(success(toPublicUser(result.value)))
    }, next)
  }
}

function updateProfileHandler({ deps }: AuthRouterOptions): RequestHandler {
  return (_req, res, next) => {
    const { name } = updateProfileBody.value(res)

    void updateProfile(deps, authenticatedUser(res).id, name).then((result) => {
      if (!result.ok) {
        next(new UnauthorizedError())
        return
      }

      res.json(success(toPublicUser(result.value)))
    }, next)
  }
}

function registerFailureToError(failure: RegisterFailure): Error {
  switch (failure.kind) {
    case 'invalid_email':
      return new ValidationError('Alamat surel tidak sah', { problem: failure.problem })
    case 'weak_password':
      return new ValidationError('Kata sandi tidak memenuhi syarat', { problem: failure.problem })
    case 'email_taken':
      return new ConflictError('Surel sudah terdaftar')
  }
}

function sessionPayload(user: User, tokens: IssuedTokens): unknown {
  return { user: toPublicUser(user), ...tokenPayload(tokens) }
}

function tokenPayload(tokens: IssuedTokens): Record<string, unknown> {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenType: 'Bearer',
    expiresIn: tokens.accessTokenExpiresIn,
  }
}

export type { Response }
