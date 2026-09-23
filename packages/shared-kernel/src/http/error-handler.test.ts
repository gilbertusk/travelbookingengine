import type { NextFunction, Request, Response } from 'express'
import { describe, expect, test, vi } from 'vitest'
import { NotFoundError } from '../errors/app-error.js'
import { createLogger } from '../logger/logger.js'
import { correlationIdOf } from './correlation-middleware.js'
import { success } from './envelope.js'
import { createErrorHandler } from './error-handler.js'

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

interface FakeResponse {
  readonly res: Response
  readonly status: ReturnType<typeof vi.fn>
  readonly json: ReturnType<typeof vi.fn>
}

function fakeResponse(headersSent: boolean): FakeResponse {
  const status = vi.fn(() => res)
  const json = vi.fn(() => res)
  const res = { headersSent, locals: { correlationId: 'req-1' }, status, json }

  // Objek tiruan ini hanya memenuhi bagian Response yang dipakai penangan galat.
  return { res: res as unknown as Response, status, json }
}

describe('createErrorHandler', () => {
  test('menyerahkan galat ke Express ketika respons sudah mulai terkirim', () => {
    // Arrange — mencoba menulis respons kedua akan menghasilkan
    // ERR_HTTP_HEADERS_SENT dan menutupi galat aslinya
    const { res, status } = fakeResponse(true)
    const next = vi.fn() as unknown as NextFunction
    const error = new Error('gagal di tengah streaming')

    // Act
    createErrorHandler(silentLogger())(error, {} as Request, res, next)

    // Assert
    expect(next).toHaveBeenCalledWith(error)
    expect(status).not.toHaveBeenCalled()
  })

  test('menulis respons galat ketika header belum terkirim', () => {
    const { res, status } = fakeResponse(false)
    const next = vi.fn() as unknown as NextFunction

    createErrorHandler(silentLogger())(new NotFoundError('tidak ada'), {} as Request, res, next)

    expect(status).toHaveBeenCalledWith(404)
    expect(next).not.toHaveBeenCalled()
  })
})

describe('correlationIdOf', () => {
  test('mengembalikan nilai dari res.locals', () => {
    expect(correlationIdOf(fakeResponse(false).res)).toBe('req-1')
  })

  test('mengembalikan unknown ketika middleware correlation belum berjalan', () => {
    const res = { locals: {} } as unknown as Response

    expect(correlationIdOf(res)).toBe('unknown')
  })
})

describe('envelope', () => {
  test('membungkus data tanpa meta ketika tidak dipaginasi', () => {
    expect(success({ id: 1 })).toEqual({ data: { id: 1 }, error: null })
  })

  test('menyertakan meta ketika hasilnya dipaginasi', () => {
    const meta = { total: 120, page: 2, limit: 20 }

    expect(success([{ id: 1 }], meta)).toEqual({ data: [{ id: 1 }], error: null, meta })
  })
})
