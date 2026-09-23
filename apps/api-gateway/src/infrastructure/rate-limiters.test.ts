import type { Redis } from 'ioredis'
import { RateLimiterMemory } from 'rate-limiter-flexible'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { RateLimitClass } from '../domain/routes.js'
import {
  DEFAULT_POLICIES,
  createMemoryRateLimiter,
  createRedisRateLimiter,
} from './rate-limiters.js'

/**
 * Pembatas laju.
 *
 * Perilaku "diizinkan lalu ditolak" sudah diuji lewat gateway. Yang diuji di
 * sini adalah bagian yang tidak terlihat dari luar: apa yang terjadi ketika
 * penyimpanannya sendiri gagal.
 */

afterEach(() => {
  vi.restoreAllMocks()
})

describe('kebijakan bawaan', () => {
  test('endpoint kredensial jauh lebih ketat daripada penjelajahan anonim', () => {
    expect(DEFAULT_POLICIES.sensitive.points).toBeLessThan(DEFAULT_POLICIES.public.points)
    expect(DEFAULT_POLICIES.search.points).toBeLessThan(DEFAULT_POLICIES.authenticated.points)
  })

  test('setiap kelas punya jendela waktu yang positif', () => {
    for (const policy of Object.values(DEFAULT_POLICIES)) {
      expect(policy.points).toBeGreaterThan(0)
      expect(policy.durationSeconds).toBeGreaterThan(0)
    }
  })
})

describe('pembatas dalam memori', () => {
  test('melaporkan sisa kuota yang menurun pada setiap permintaan', async () => {
    const limiter = createMemoryRateLimiter({
      ...DEFAULT_POLICIES,
      public: { points: 3, durationSeconds: 60 },
    })

    const pertama = await limiter.consume('public', 'ip:1.1.1.1')
    const kedua = await limiter.consume('public', 'ip:1.1.1.1')

    expect(pertama).toMatchObject({ allowed: true, limit: 3, remaining: 2 })
    expect(kedua.remaining).toBe(1)
  })

  test('kuota dihitung per kunci, bukan per proses', async () => {
    // Kalau tidak, satu pengguna yang ramai membuat seluruh pengguna lain
    // ikut tertolak.
    const limiter = createMemoryRateLimiter({
      ...DEFAULT_POLICIES,
      sensitive: { points: 1, durationSeconds: 60 },
    })

    await limiter.consume('sensitive', 'ip:1.1.1.1')

    expect(await limiter.consume('sensitive', 'ip:1.1.1.1')).toMatchObject({ allowed: false })
    expect(await limiter.consume('sensitive', 'ip:2.2.2.2')).toMatchObject({ allowed: true })
  })

  test('penolakan menyertakan waktu tunggu yang dapat diberitahukan ke klien', async () => {
    const limiter = createMemoryRateLimiter({
      ...DEFAULT_POLICIES,
      sensitive: { points: 1, durationSeconds: 60 },
    })

    await limiter.consume('sensitive', 'ip:3.3.3.3')
    const ditolak = await limiter.consume('sensitive', 'ip:3.3.3.3')

    expect(ditolak.allowed).toBe(false)
    expect(ditolak.remaining).toBe(0)
    expect(ditolak.resetAfterSeconds).toBeGreaterThan(0)
  })

  test('kelas yang tidak dikenal melempar galat, bukan mengizinkan diam-diam', async () => {
    // Kelas datang dari tabel rute, jadi ini hanya terjadi kalau ada rute baru
    // yang salah tulis. Gagal keras di sini berarti ketahuan saat pengujian;
    // mengizinkan diam-diam berarti rute itu berjalan tanpa batas laju sama
    // sekali dan tidak ada yang menyadarinya.
    const limiter = createMemoryRateLimiter()

    await expect(limiter.consume('belum-ada' as RateLimitClass, 'ip:1.1.1.1')).rejects.toThrow(
      /belum-ada/,
    )
  })

  test('kegagalan penyimpanan diteruskan, bukan dianggap sebagai kuota habis', async () => {
    // Galat koneksi Redis bukan jawaban "silakan coba lagi nanti". Menganggapnya
    // demikian membuat seluruh lalu lintas ditolak 429 saat Redis tumbang,
    // dan menyembunyikan penyebab sebenarnya dari siapa pun yang membaca log.
    vi.spyOn(RateLimiterMemory.prototype, 'consume').mockRejectedValue(
      new Error('koneksi penyimpanan terputus'),
    )

    const limiter = createMemoryRateLimiter()

    await expect(limiter.consume('public', 'ip:1.1.1.1')).rejects.toThrow(
      'koneksi penyimpanan terputus',
    )
  })
})

describe('pembatas berbasis Redis', () => {
  test('dibangun untuk seluruh kelas dengan kebijakan yang sama', () => {
    // Pembatas dalam memori tidak berarti apa-apa begitu gateway digandakan:
    // sepuluh replika masing-masing mengizinkan kuota penuh. Yang dipakai saat
    // berjalan adalah yang ini.
    //
    // CATATAN: pengujian ini hanya membuktikan pembangunannya. Perilakunya
    // terhadap Redis sungguhan belum diverifikasi — lihat
    // docs/plan/step-08-api-gateway.md.
    const defineCommand = vi.fn()
    const klienPalsu = { defineCommand } as unknown as Redis

    const limiter = createRedisRateLimiter(klienPalsu)

    expect(typeof limiter.consume).toBe('function')
    // Satu skrip Lua per kelas: bukti keempat pembatas benar-benar dibangun.
    expect(defineCommand.mock.calls.length).toBe(Object.keys(DEFAULT_POLICIES).length)
  })
})
