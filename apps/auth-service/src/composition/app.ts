import {
  createHealthRouter,
  createHttpServer,
  createMetrics,
  finalizeHttpServer,
  type HealthCheck,
  type Logger,
  type Metrics,
} from '@tbe/shared-kernel'
import type { Express } from 'express'
import type { AuthDeps } from '../application/ports.js'
import type { Config } from '../config.js'
import type { PrismaClient } from '../generated/prisma/client.js'
import { createArgon2Hasher } from '../infrastructure/argon2-hasher.js'
import { createJoseTokenIssuer } from '../infrastructure/jose-token-issuer.js'
import {
  createPrismaSessionRepository,
  createPrismaUserRepository,
} from '../infrastructure/prisma-repositories.js'
import {
  createMemoryLoginLimiter,
  createRefreshTokenFactory,
  systemClock,
  uuidFactory,
} from '../infrastructure/runtime.js'
import { createAuthRouter } from '../http/auth-routes.js'

const MS_PER_DAY = 86_400_000
const MS_PER_MINUTE = 60_000

export interface AuthApp {
  readonly app: Express
  readonly deps: AuthDeps
  readonly metrics: Metrics
}

export interface BuildAuthAppOptions {
  readonly config: Config
  readonly logger: Logger
  readonly prisma: PrismaClient
}

export function buildAuthDeps(options: BuildAuthAppOptions): AuthDeps {
  const { config, prisma } = options

  return {
    users: createPrismaUserRepository(prisma),
    sessions: createPrismaSessionRepository(prisma),
    hasher: createArgon2Hasher(),
    tokens: createJoseTokenIssuer({
      secret: config.JWT_SECRET,
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
      accessTokenTtlSeconds: config.ACCESS_TOKEN_TTL_SECONDS,
    }),
    refreshTokens: createRefreshTokenFactory(config.REFRESH_TOKEN_TTL_DAYS * MS_PER_DAY),
    ids: uuidFactory,
    clock: systemClock,
    limiter: createMemoryLoginLimiter({
      maxFailures: config.LOGIN_MAX_FAILURES,
      windowMs: config.LOGIN_FAILURE_WINDOW_MINUTES * MS_PER_MINUTE,
    }),
  }
}

export interface HttpAppOptions {
  readonly deps: AuthDeps
  readonly logger: Logger
  readonly serviceName: string
  readonly corsOrigins?: readonly string[] | undefined
  readonly healthChecks?: readonly HealthCheck[] | undefined
}

/**
 * Merangkai aplikasi HTTP dari dependensi yang sudah jadi.
 *
 * Dipisahkan dari perangkaian dependensi supaya pengujian dapat memakai
 * aplikasi yang sama persis dengan yang berjalan di produksi, hanya dengan
 * repository dalam memori. Aplikasi uji yang dirangkai sendiri akan berbeda
 * dari yang sesungguhnya, dan perbedaannya selalu ada di tempat yang tidak
 * diduga.
 */
export function createAuthHttpApp(options: HttpAppOptions): { app: Express; metrics: Metrics } {
  const metrics = createMetrics({ serviceName: options.serviceName })

  const app = createHttpServer({
    logger: options.logger,
    metrics,
    corsOrigins: options.corsOrigins,
  })

  app.use(createHealthRouter(options.healthChecks ?? [], options.logger))
  app.use('/auth', createAuthRouter({ deps: options.deps, logger: options.logger }))

  finalizeHttpServer(app, options.logger)

  return { app, metrics }
}

export function buildAuthApp(options: BuildAuthAppOptions): AuthApp {
  const { config, logger, prisma } = options
  const deps = buildAuthDeps(options)

  const { app, metrics } = createAuthHttpApp({
    deps,
    logger,
    serviceName: config.SERVICE_NAME,
    corsOrigins: config.CORS_ORIGINS,
    healthChecks: [
      {
        name: 'database',
        check: async () => {
          await prisma.$queryRaw`SELECT 1`
          return true
        },
      },
    ],
  })

  return { app, deps, metrics }
}
