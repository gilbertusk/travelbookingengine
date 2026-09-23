import {
  pino,
  type DestinationStream,
  type Logger,
  type LoggerOptions as PinoLoggerOptions,
} from 'pino'
import { getCorrelationId } from '../correlation/correlation.js'

/**
 * Logger terstruktur untuk seluruh service.
 *
 * Dua hal yang tidak boleh dilupakan siapa pun, jadi dikerjakan di sini sekali:
 * setiap baris log otomatis membawa correlationId, dan field sensitif diredaksi
 * tanpa pemanggil perlu ingat. Redaksi yang bergantung pada kedisiplinan
 * pemanggil akan bocor — cukup sekali seseorang menulis logger.info({ user })
 * dengan objek yang kebetulan memuat passwordHash.
 */

export const REDACTED = '[REDACTED]'

const SENSITIVE_KEYS = [
  'password',
  'passwordHash',
  'currentPassword',
  'newPassword',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'authorization',
  'apiKey',
  'secret',
  'clientSecret',
  'serverKey',
  'clientKey',
  'credentials',
  'cardNumber',
  'cvv',
  'pin',
] as const

// Pino tidak mendukung wildcard rekursif tanpa batas, jadi kedalamannya
// dinyatakan eksplisit. Tiga tingkat mencakup seluruh bentuk objek yang
// masuk akal untuk dicatat; lebih dari itu berarti log-nya terlalu gemuk.
const REDACT_PATHS = SENSITIVE_KEYS.flatMap((key) => [
  key,
  `*.${key}`,
  `*.*.${key}`,
  `*.*.*.${key}`,
])

const REQUEST_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
]

export interface LoggerOptions {
  readonly serviceName: string
  readonly level?: string | undefined
  readonly pretty?: boolean | undefined
  /** Hanya dipakai pengujian, agar keluaran dapat ditangkap dan diperiksa. */
  readonly destination?: DestinationStream | undefined
}

/**
 * Menyusun opsi Pino. Dipisahkan dari createLogger agar dapat diuji tanpa
 * menyalakan worker thread pino-pretty, yang menggantung proses uji.
 */
export function buildLoggerOptions(options: LoggerOptions): PinoLoggerOptions {
  const usePrettyTransport = options.pretty === true && options.destination === undefined

  return {
    level: options.level ?? 'info',
    base: { service: options.serviceName },
    redact: {
      paths: [...REDACT_PATHS, ...REQUEST_REDACT_PATHS],
      censor: REDACTED,
    },
    mixin: (): Record<string, string> => {
      const correlationId = getCorrelationId()
      return correlationId === undefined ? {} : { correlationId }
    },
    formatters: {
      level: (label: string): Record<string, string> => ({ level: label }),
    },
    ...(usePrettyTransport
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss' },
          },
        }
      : {}),
  }
}

export function createLogger(options: LoggerOptions): Logger {
  const pinoOptions = buildLoggerOptions(options)

  return options.destination === undefined
    ? pino(pinoOptions)
    : pino(pinoOptions, options.destination)
}
