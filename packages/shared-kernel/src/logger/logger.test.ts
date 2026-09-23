import { describe, expect, test } from 'vitest'
import { runWithCorrelation } from '../correlation/correlation.js'
import { REDACTED, buildLoggerOptions, createLogger } from './logger.js'

interface CapturedLogger {
  readonly log: ReturnType<typeof createLogger>
  readonly lines: () => readonly Record<string, unknown>[]
}

function captureLogger(serviceName = 'uji-service'): CapturedLogger {
  const captured: string[] = []
  const log = createLogger({
    serviceName,
    level: 'debug',
    destination: {
      write(chunk: string): void {
        captured.push(chunk)
      },
    },
  })

  return {
    log,
    lines: () => captured.map((chunk) => JSON.parse(chunk) as Record<string, unknown>),
  }
}

describe('logger', () => {
  test('menyertakan nama service di setiap baris', () => {
    const { log, lines } = captureLogger('booking-service')

    log.info('pemesanan dibuat')

    expect(lines()[0]?.service).toBe('booking-service')
  })

  test('menyertakan correlationId otomatis tanpa diteruskan pemanggil', () => {
    const { log, lines } = captureLogger()

    runWithCorrelation('req-77', () => {
      log.info('sedang memproses')
    })

    expect(lines()[0]?.correlationId).toBe('req-77')
  })

  test('tidak menyertakan correlationId di luar konteks', () => {
    const { log, lines } = captureLogger()

    log.info('pekerjaan terjadwal')

    expect(lines()[0]).not.toHaveProperty('correlationId')
  })

  test('meredaksi field sensitif di tingkat atas', () => {
    const { log, lines } = captureLogger()

    log.info({ password: 'rahasia123', email: 'a@b.com' }, 'pendaftaran')

    const baris = lines()[0]
    expect(baris?.password).toBe(REDACTED)
    expect(baris?.email).toBe('a@b.com')
  })

  test('meredaksi field sensitif yang bersarang', () => {
    const { log, lines } = captureLogger()

    // Arrange — bentuk yang paling sering tidak sengaja ikut tercatat
    log.info({ user: { id: '1', passwordHash: '$argon2id$xxx' } }, 'pengguna dimuat')

    const user = lines()[0]?.user as Record<string, unknown>
    expect(user.passwordHash).toBe(REDACTED)
    expect(user.id).toBe('1')
  })

  test('meredaksi kredensial supplier dan kunci pembayaran', () => {
    const { log, lines } = captureLogger()

    log.info(
      { supplier: { code: 'SKY', credentials: 'basic xyz' }, payment: { serverKey: 'SB-Mid-xyz' } },
      'permintaan keluar',
    )

    const baris = lines()[0]
    const supplier = baris?.supplier as Record<string, unknown>
    const payment = baris?.payment as Record<string, unknown>
    expect(supplier.credentials).toBe(REDACTED)
    expect(supplier.code).toBe('SKY')
    expect(payment.serverKey).toBe(REDACTED)
  })

  test('meredaksi header authorization dan cookie pada log permintaan', () => {
    const { log, lines } = captureLogger()

    log.info(
      { req: { method: 'GET', headers: { authorization: 'Bearer abc', cookie: 'sid=1' } } },
      'permintaan masuk',
    )

    const req = lines()[0]?.req as { headers: Record<string, unknown>; method: string }
    expect(req.headers.authorization).toBe(REDACTED)
    expect(req.headers.cookie).toBe(REDACTED)
    expect(req.method).toBe('GET')
  })

  test('menulis level sebagai label yang terbaca, bukan angka', () => {
    const { log, lines } = captureLogger()

    log.warn('supplier melambat')

    expect(lines()[0]?.level).toBe('warn')
  })

  test('dapat dibuat tanpa destination untuk pemakaian sungguhan', () => {
    const log = createLogger({ serviceName: 'produksi', level: 'silent' })

    expect(typeof log.info).toBe('function')
  })

  test('memakai transport pino-pretty hanya ketika pretty diminta', () => {
    const opsiBiasa = buildLoggerOptions({ serviceName: 'a' })
    const opsiPretty = buildLoggerOptions({ serviceName: 'a', pretty: true })

    expect(opsiBiasa).not.toHaveProperty('transport')
    expect(opsiPretty.transport).toMatchObject({ target: 'pino-pretty' })
  })

  test('destination mengalahkan pretty agar keluaran uji tetap JSON', () => {
    const opsi = buildLoggerOptions({
      serviceName: 'a',
      pretty: true,
      destination: {
        write(): void {
          // tidak dipakai di pengujian ini
        },
      },
    })

    expect(opsi).not.toHaveProperty('transport')
  })

  test('level bawaan adalah info ketika tidak ditentukan', () => {
    expect(buildLoggerOptions({ serviceName: 'a' }).level).toBe('info')
  })

  test('menghormati ambang level', () => {
    const captured: string[] = []
    const log = createLogger({
      serviceName: 'uji',
      level: 'warn',
      destination: {
        write(chunk: string): void {
          captured.push(chunk)
        },
      },
    })

    log.debug('tidak boleh muncul')
    log.error('harus muncul')

    expect(captured).toHaveLength(1)
  })
})
