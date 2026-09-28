import { NotFoundError, success } from '@tbe/shared-kernel'
import { Router, type RequestHandler, type Response } from 'express'
import { bookingStatus, watchStatus, type StatusSnapshot } from '../application/booking-status.js'
import type { BookingDeps } from '../application/ports.js'
import { bookingParams } from './booking-routes.js'
import { identity } from './identity.js'
import { statusView } from './views.js'

/**
 * Antarmuka status (Step 19): satu pembacaan, dan aliran Server-Sent Events.
 *
 * SSE, bukan WebSocket: arusnya satu arah — server ke peramban — dan SSE
 * berjalan di atas HTTP biasa, jadi api-gateway cukup meneruskan tanpa
 * penyangga (rute `/bookings/stream` di Step 08 sudah ditandai `streaming`).
 * Peramban menyambung ulang sendiri bila koneksinya putus.
 *
 * Aliran berada di `/bookings/stream/:id`, bukan `/bookings/:id/stream`, karena
 * pencocokan gateway berdasarkan AWALAN: hanya awalan `/bookings/stream` yang
 * dilayani tanpa batas waktu permintaan biasa.
 */

export interface StatusStreamOptions {
  /** Selang pembacaan keadaan. */
  readonly pollMs: number
  /**
   * Selang komentar penjaga koneksi. Proxy dan penyeimbang beban menutup
   * koneksi yang diam; komentar SSE (`:`) tidak terlihat oleh EventSource.
   */
  readonly heartbeatMs: number
}

export function createStatusRouter(deps: BookingDeps, options: StatusStreamOptions): Router {
  const router = Router()

  router.get('/bookings/stream/:id', identity, bookingParams, streamHandler(deps, options))
  router.get('/bookings/:id/status', identity, bookingParams, statusHandler(deps))

  return router
}

function statusHandler(deps: BookingDeps): RequestHandler {
  return (_req, res, next) => {
    const userId = identity.value(res)

    void bookingStatus(deps, userId, bookingParams.value(res).id).then((snapshot) => {
      if (snapshot === undefined) {
        next(new NotFoundError('Pemesanan tidak ditemukan'))
        return
      }
      res.json(success(statusView(snapshot)))
    }, next)
  }
}

function streamHandler(deps: BookingDeps, options: StatusStreamOptions): RequestHandler {
  return (req, res, next) => {
    const request = { userId: identity.value(res), bookingId: bookingParams.value(res).id }

    // Pemilik diperiksa SEBELUM aliran dibuka: pemesanan orang lain dijawab
    // 404 JSON biasa, sama dengan pemesanan yang tidak ada.
    void bookingStatus(deps, request.userId, request.bookingId).then((first) => {
      if (first === undefined) {
        next(new NotFoundError('Pemesanan tidak ditemukan'))
        return
      }

      const controller = new AbortController()
      req.on('close', () => {
        controller.abort()
      })
      void stream(deps, res, { request, options, signal: controller.signal })
    }, next)
  }
}

interface Stream {
  readonly request: { readonly userId: string; readonly bookingId: string }
  readonly options: StatusStreamOptions
  readonly signal: AbortSignal
}

async function stream(deps: BookingDeps, res: Response, context: Stream): Promise<void> {
  res.status(200)
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  // nginx dan sejenisnya menyangga respons secara bawaan; aliran yang
  // tersangga sampai ke peramban sekaligus di akhir, bukan per perubahan.
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  const heartbeat = setInterval(() => {
    res.write(': tetap tersambung\n\n')
  }, context.options.heartbeatMs)

  try {
    const changes = watchStatus(deps, context.request, {
      intervalMs: context.options.pollMs,
      signal: context.signal,
      sleep: pause,
    })
    for await (const snapshot of changes) writeStatus(res, snapshot)
    if (!context.signal.aborted) res.write('event: end\ndata: {}\n\n')
  } catch (error) {
    // Kepala respons sudah terkirim; galat tidak dapat lagi menjadi status
    // HTTP. Dicatat, lalu aliran ditutup — EventSource menyambung ulang.
    deps.logger.error({ err: error, bookingId: context.request.bookingId }, 'aliran status gagal')
  } finally {
    clearInterval(heartbeat)
    res.end()
  }
}

function writeStatus(res: Response, snapshot: StatusSnapshot): void {
  const view = statusView(snapshot)
  const id = `${String(view.version)}-${String(snapshot.saga?.version ?? 0)}`

  res.write(`event: status\nid: ${id}\ndata: ${JSON.stringify(view)}\n\n`)
}

/** Menunggu, atau berhenti lebih awal bila penonton pergi. */
async function pause(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}
