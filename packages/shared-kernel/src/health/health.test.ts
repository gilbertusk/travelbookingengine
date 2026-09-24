import request from 'supertest'
import { describe, expect, test } from 'vitest'
import { createLogger } from '../logger/logger.js'
import { createHttpServer, finalizeHttpServer } from '../http/server.js'
import { createHealthRouter, runChecks, type HealthCheck } from './health.js'

const silentLogger = (): ReturnType<typeof createLogger> =>
  createLogger({
    serviceName: 'uji',
    level: 'silent',
    destination: {
      write(): void {
        // keluaran log tidak diuji di berkas ini
      },
    },
  })

function buildApp(checks: readonly HealthCheck[]): ReturnType<typeof createHttpServer> {
  const logger = silentLogger()
  const app = createHttpServer({ logger })
  app.use(createHealthRouter(checks, logger))
  return finalizeHttpServer(app, logger)
}

const sehat = (name: string): HealthCheck => ({ name, check: async () => Promise.resolve(true) })
const tidakSehat = (name: string): HealthCheck => ({
  name,
  check: async () => Promise.resolve(false),
})
const melempar = (name: string): HealthCheck => ({
  name,
  check: async () => {
    await Promise.resolve()
    throw new Error('koneksi ditolak')
  },
})

describe('health', () => {
  test('liveness selalu 200 meski dependensi tidak sehat', async () => {
    // Liveness menjawab "proses masih hidup", bukan "dependensi sehat".
    // Menyamakan keduanya membuat replika dibunuh berulang saat database
    // terputus sementara.
    const response = await request(buildApp([tidakSehat('db')])).get('/health/live')

    expect(response.status).toBe(200)
    expect(response.body.data.status).toBe('alive')
  })

  test('readiness 200 ketika seluruh dependensi sehat', async () => {
    const response = await request(buildApp([sehat('db'), sehat('redis')])).get('/health/ready')

    expect(response.status).toBe(200)
    expect(response.body.data.status).toBe('ready')
    expect(response.body.data.dependencies).toEqual([
      { name: 'db', healthy: true },
      { name: 'redis', healthy: true },
    ])
  })

  test('readiness 503 ketika satu dependensi tidak sehat', async () => {
    const response = await request(buildApp([sehat('db'), tidakSehat('redis')])).get(
      '/health/ready',
    )

    expect(response.status).toBe(503)
    expect(response.body.data.status).toBe('not_ready')
  })

  test('readiness menyebut dependensi mana yang bermasalah', async () => {
    const response = await request(buildApp([sehat('db'), tidakSehat('kafka')])).get(
      '/health/ready',
    )

    const bermasalah = (response.body.data.dependencies as { name: string; healthy: boolean }[])
      .filter((d) => !d.healthy)
      .map((d) => d.name)
    expect(bermasalah).toEqual(['kafka'])
  })

  test('pemeriksaan yang melempar dianggap tidak sehat, bukan merusak endpoint', async () => {
    const response = await request(buildApp([melempar('db')])).get('/health/ready')

    expect(response.status).toBe(503)
    expect(response.body.data.dependencies).toEqual([{ name: 'db', healthy: false }])
  })

  test('readiness 200 ketika tidak ada dependensi yang didaftarkan', async () => {
    const response = await request(buildApp([])).get('/health/ready')

    expect(response.status).toBe(200)
  })

  test('runChecks menjalankan seluruh pemeriksaan secara paralel', async () => {
    // Arrange — dibuktikan dari urutan kejadian, bukan dari lama waktunya.
    //
    // Pengukuran waktu membuat pengujian ini gagal pada mesin yang sedang
    // sibuk meski kodenya benar, dan pengujian yang gagal karena beban adalah
    // pengujian yang mengajari orang mengabaikan hasil uji.
    //
    // Ketiga pemeriksaan ditahan sampai semuanya sudah dimulai. Kalau
    // dijalankan berurutan, yang pertama tidak akan pernah selesai — dan
    // pengujiannya habis waktu alih-alih lulus secara kebetulan.
    const started: string[] = []
    let releaseAll = (): void => undefined
    const allStarted = new Promise<void>((resolve) => {
      releaseAll = resolve
    })

    const menunggu = (name: string): HealthCheck => ({
      name,
      check: async () => {
        started.push(name)
        if (started.length === 3) releaseAll()
        await allStarted
        return true
      },
    })

    // Act
    const hasil = await runChecks([menunggu('a'), menunggu('b'), menunggu('c')], silentLogger())

    // Assert
    expect(hasil).toHaveLength(3)
    expect(started).toEqual(['a', 'b', 'c'])
  })
})
