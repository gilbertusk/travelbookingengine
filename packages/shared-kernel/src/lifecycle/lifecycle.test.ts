import { afterEach, describe, expect, test, vi } from 'vitest'
import { createLogger } from '../logger/logger.js'
import { createApp, type ManagedResource } from './lifecycle.js'

const silentLogger = (): ReturnType<typeof createLogger> =>
  createLogger({
    serviceName: 'uji',
    level: 'silent',
    destination: {
      write(): void {
        // sengaja dibuang; keluaran log tidak diuji di berkas ini
      },
    },
  })

function trackedResource(name: string, jejak: string[]): ManagedResource {
  return {
    name,
    start: async () => {
      jejak.push(`start:${name}`)
      await Promise.resolve()
    },
    stop: async () => {
      jejak.push(`stop:${name}`)
      await Promise.resolve()
    },
  }
}

const baseOptions = { serviceName: 'uji', logger: silentLogger(), handleSignals: false }

afterEach(() => {
  // Test sinyal memata-matai process.once dan process.exit; tanpa pemulihan,
  // test berikutnya mewarisi tiruan itu dan gagal dengan sebab yang menyesatkan.
  vi.restoreAllMocks()
})

describe('createApp', () => {
  test('menyalakan sumber daya sesuai urutan deklarasi', async () => {
    const jejak: string[] = []
    const app = createApp({
      ...baseOptions,
      resources: [
        trackedResource('db', jejak),
        trackedResource('broker', jejak),
        trackedResource('http', jejak),
      ],
    })

    await app.start()

    expect(jejak).toEqual(['start:db', 'start:broker', 'start:http'])
  })

  test('menutup sumber daya dalam urutan terbalik', async () => {
    // Arrange — consumer harus berhenti sebelum databasenya ditutup
    const jejak: string[] = []
    const app = createApp({
      ...baseOptions,
      resources: [
        trackedResource('db', jejak),
        trackedResource('consumer', jejak),
        trackedResource('http', jejak),
      ],
    })

    // Act
    await app.start()
    jejak.length = 0
    await app.stop('uji')

    // Assert
    expect(jejak).toEqual(['stop:http', 'stop:consumer', 'stop:db'])
  })

  test('mengembalikan sumber daya yang sudah menyala ketika startup gagal di tengah', async () => {
    const jejak: string[] = []
    const gagal: ManagedResource = {
      name: 'broker',
      start: async () => {
        await Promise.resolve()
        throw new Error('broker tidak dapat dihubungi')
      },
      stop: async () => {
        jejak.push('stop:broker')
        await Promise.resolve()
      },
    }

    const app = createApp({
      ...baseOptions,
      resources: [trackedResource('db', jejak), gagal, trackedResource('http', jejak)],
    })

    await expect(app.start()).rejects.toThrow('broker tidak dapat dihubungi')

    // db sudah menyala dan harus ditutup; broker gagal jadi tidak pernah dianggap menyala
    expect(jejak).toEqual(['start:db', 'stop:db'])
  })

  test('tidak menyalakan sumber daya setelah yang gagal', async () => {
    const jejak: string[] = []
    const gagal: ManagedResource = {
      name: 'broker',
      start: async () => {
        await Promise.resolve()
        throw new Error('gagal')
      },
      stop: async () => Promise.resolve(),
    }

    const app = createApp({ ...baseOptions, resources: [gagal, trackedResource('http', jejak)] })

    await expect(app.start()).rejects.toThrow()

    expect(jejak).not.toContain('start:http')
  })

  test('melanjutkan penutupan meski satu sumber daya gagal ditutup', async () => {
    const jejak: string[] = []
    const bermasalah: ManagedResource = {
      name: 'nakal',
      start: async () => Promise.resolve(),
      stop: async () => {
        await Promise.resolve()
        throw new Error('gagal menutup')
      },
    }

    const app = createApp({
      ...baseOptions,
      resources: [trackedResource('db', jejak), bermasalah, trackedResource('http', jejak)],
    })

    await app.start()
    jejak.length = 0
    await app.stop('uji')

    // db tetap ditutup meski 'nakal' gagal di tengah urutan
    expect(jejak).toEqual(['stop:http', 'stop:db'])
  })

  test('stop bersifat idempoten dan tidak menutup dua kali', async () => {
    const jejak: string[] = []
    const app = createApp({ ...baseOptions, resources: [trackedResource('db', jejak)] })

    await app.start()
    jejak.length = 0
    await Promise.all([app.stop('a'), app.stop('b'), app.stop('c')])

    expect(jejak).toEqual(['stop:db'])
  })

  test('menyerah setelah batas waktu ketika penutupan menggantung', async () => {
    // Arrange — sumber daya yang stop-nya tidak pernah selesai
    const menggantung: ManagedResource = {
      name: 'menggantung',
      start: async () => Promise.resolve(),
      stop: () => new Promise<void>(() => undefined),
    }

    const app = createApp({
      ...baseOptions,
      resources: [menggantung],
      shutdownTimeoutMs: 50,
    })

    // Act
    await app.start()
    const mulai = Date.now()
    await app.stop('uji')
    const durasi = Date.now() - mulai

    // Assert — selesai karena batas waktu, bukan karena sumber dayanya selesai
    expect(durasi).toBeGreaterThanOrEqual(40)
    expect(durasi).toBeLessThan(2_000)
  })

  test('menerima sumber daya tanpa fungsi start', async () => {
    const jejak: string[] = []
    const app = createApp({
      ...baseOptions,
      resources: [
        {
          name: 'tanpa-start',
          stop: async () => {
            jejak.push('stop:tanpa-start')
            await Promise.resolve()
          },
        },
      ],
    })

    await app.start()
    await app.stop('uji')

    expect(jejak).toEqual(['stop:tanpa-start'])
  })

  test('tidak mendaftarkan handler sinyal ketika dimatikan', async () => {
    const once = vi.spyOn(process, 'once')
    const app = createApp({ ...baseOptions, resources: [] })

    await app.start()

    expect(once).not.toHaveBeenCalled()
  })

  test('mendaftarkan handler untuk SIGTERM dan SIGINT', async () => {
    const once = vi.spyOn(process, 'once').mockReturnValue(process)
    const app = createApp({ serviceName: 'uji', logger: silentLogger(), resources: [] })

    await app.start()

    const sinyal = once.mock.calls.map((call) => call[0])
    expect(sinyal).toContain('SIGTERM')
    expect(sinyal).toContain('SIGINT')
  })

  test('sinyal memicu penutupan lalu keluar dengan kode 0', async () => {
    // Arrange — tangkap handler yang didaftarkan, jangan biarkan process.exit sungguhan
    const handlers = new Map<string, () => void>()
    vi.spyOn(process, 'once').mockImplementation(((signal: string, handler: () => void) => {
      handlers.set(signal, handler)
      return process
    }) as typeof process.once)
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    const jejak: string[] = []
    const app = createApp({
      serviceName: 'uji',
      logger: silentLogger(),
      resources: [trackedResource('db', jejak)],
    })

    // Act
    await app.start()
    jejak.length = 0
    handlers.get('SIGTERM')?.()
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalled()
    })

    // Assert
    expect(jejak).toEqual(['stop:db'])
    expect(exit).toHaveBeenCalledWith(0)
  })
})
