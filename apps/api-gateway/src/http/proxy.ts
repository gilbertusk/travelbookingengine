import {
  AppError,
  CORRELATION_HEADER,
  TimeoutError,
  correlationIdOf,
  currentTraceparent,
} from '@tbe/shared-kernel'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { Upstream, UpstreamOutcome } from '../application/ports.js'
import { identityHeaders, isHopByHop, stripForgedHeaders } from '../domain/identity.js'
import { matchRoute, type RouteDefinition } from '../domain/routes.js'
import { identityOf } from './authenticate.js'

/**
 * Penerusan permintaan ke service hulu.
 *
 * Badan permintaan dan respons diteruskan sebagai aliran, tidak pernah
 * dikumpulkan di memori. Selain membuat unggahan besar tidak memakan memori
 * gateway, inilah yang membuat Server-Sent Events bekerja: respons yang
 * dikumpulkan lebih dulu baru dikirim bukan lagi aliran.
 */

const METHODS_WITHOUT_BODY = new Set(['GET', 'HEAD', 'OPTIONS'])

export function createProxyHandler(upstream: Upstream): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const route = matchRoute(req.method, req.path)

    if (route === undefined) {
      // Dibiarkan jatuh ke penangan 404 milik shared-kernel, supaya bentuk
      // respons galatnya sama dengan seluruh galat lain.
      next()
      return
    }

    void upstream
      .send({
        service: route.service,
        method: req.method,
        path: req.originalUrl,
        headers: outboundHeaders(req, res),
        body: METHODS_WITHOUT_BODY.has(req.method.toUpperCase()) ? undefined : req,
        timeoutMs: route.timeoutMs,
      })
      .then((outcome) => {
        deliver(outcome, res, route, next)
      }, next)
  }
}

/**
 * Header yang dikirim ke hulu.
 *
 * Urutannya penting: header palsu dari klien dibuang LEBIH DULU, baru identitas
 * hasil verifikasi ditambahkan. Menambahkan lebih dulu lalu membersihkan akan
 * ikut menghapus identitas yang baru saja kita pasang.
 */
export function outboundHeaders(req: Request, res: Response): Record<string, string | string[]> {
  const cleaned = stripForgedHeaders(req.headers)
  const headers: Record<string, string | string[]> = {}

  for (const [name, value] of Object.entries(cleaned)) {
    if (isHopByHop(name) || value === undefined) continue
    headers[name] = value as string | string[]
  }

  headers[CORRELATION_HEADER] = correlationIdOf(res)

  const traceparent = currentTraceparent()
  if (traceparent !== undefined) headers.traceparent = traceparent

  const identity = identityOf(res)
  if (identity !== undefined) {
    Object.assign(headers, identityHeaders({ userId: identity.userId, email: identity.email }))
  }

  return headers
}

function deliver(
  outcome: UpstreamOutcome,
  res: Response,
  route: RouteDefinition,
  next: NextFunction,
): void {
  if (outcome.kind === 'timeout') {
    next(
      new TimeoutError({
        message: `service ${route.service} melewati batas waktu`,
        timeoutMs: route.timeoutMs,
        upstream: route.service,
      }),
    )
    return
  }

  if (outcome.kind === 'unreachable') {
    // Nama host internal tidak pernah ikut ke klien. Pesan generiknya
    // dihasilkan toErrorResponse karena statusnya 5xx — lihat NFR-15.
    next(
      new AppError({
        code: 'UPSTREAM_UNAVAILABLE',
        httpStatus: 503,
        message: `service ${route.service} tidak dapat dihubungi`,
      }),
    )
    return
  }

  res.status(outcome.statusCode)

  for (const [name, value] of Object.entries(outcome.headers)) {
    if (value === undefined || isHopByHop(name)) continue
    res.setHeader(name, value)
  }

  if (route.streaming === true) {
    // Tanpa ini, proksi di depan gateway (nginx, Cloudflare) akan menahan
    // aliran sampai penuh, dan SSE berhenti bekerja tanpa satu pun galat.
    res.setHeader('cache-control', 'no-cache, no-transform')
    res.setHeader('x-accel-buffering', 'no')
    res.flushHeaders()
  }

  outcome.body.pipe(res)

  outcome.body.on('error', () => {
    // Aliran yang putus di tengah tidak dapat lagi menjadi respons galat yang
    // rapi — header-nya sudah terkirim. Yang benar adalah menutup koneksi,
    // supaya klien tahu responsnya tidak lengkap.
    res.destroy()
  })
}
