import type { NextFunction, Request, RequestHandler, Response } from 'express'
import {
  failureFor,
  latencyFor,
  type ChaosRegistry,
  type FailureMode,
} from '../application/chaos.js'
import type { FaultScript } from '../application/fault-script.js'
import { SUPPLIER_PROFILES, type SupplierCode } from '../domain/supplier.js'
import { operationOf } from './operation.js'

/**
 * Menyuntikkan latensi dan kegagalan sebelum permintaan mencapai penangannya.
 *
 * Setiap mode di sini mewakili kegagalan yang benar-benar terjadi pada
 * integrasi supplier sungguhan, dan masing-masing menuntut penanganan yang
 * berbeda di sisi klien. Menyederhanakannya menjadi "kadang 500" akan membuat
 * kebijakan retry pada Step 11 tidak punya apa pun untuk dibedakan.
 */

/** Cukup lama untuk melewati batas waktu klien mana pun, tanpa menggantung selamanya. */
const TIMEOUT_HOLD_MS = 60_000

export interface ChaosMiddlewareOptions {
  readonly code: SupplierCode
  readonly chaos: ChaosRegistry
  readonly random: () => number
  /**
   * Melewati penundaan latensi, tetapi TIDAK melewati suntikan kegagalan.
   * Uji integrasi butuh supplier yang gagal, bukan supplier yang lambat —
   * menunggu tiga detik per permintaan hanya membuat rangkaian uji lamban
   * tanpa menambah satu pun jaminan.
   */
  readonly instant?: boolean | undefined
  /**
   * Kegagalan terjadwal per operasi (Step 20). Diperiksa SEBELUM keacakan:
   * jadwal adalah perintah eksplisit dari uji, dan tidak boleh kalah oleh
   * undian peluang bawaan profil.
   */
  readonly script?: FaultScript | undefined
}

export function createChaosMiddleware(options: ChaosMiddlewareOptions): RequestHandler {
  const { code, chaos, random } = options
  const isXml = SUPPLIER_PROFILES[code].protocol === 'soap-xml'

  return (req: Request, res: Response, next: NextFunction): void => {
    const operation = operationOf(code, req)
    const scripted = operation === undefined ? undefined : options.script?.take(code, operation)

    if (scripted === 'lose_response') {
      loseResponse(req, res, next)
      return
    }

    const state = chaos.get(code)
    const failure = scripted ?? failureFor(code, state, random)
    const delayMs = options.instant === true ? 0 : latencyFor(code, state, random)

    if (failure === 'connection_reset') {
      // Supplier yang mati tidak membalas apa pun — ia memutus koneksi.
      // Membalas 503 di sini akan menyembunyikan seluruh kelas kegagalan
      // jaringan yang justru paling sulit ditangani klien.
      res.socket?.destroy()
      return
    }

    if (failure === 'timeout') {
      holdUntilTimeout(req, res)
      return
    }

    setTimeout(() => {
      if (failure === undefined) {
        next()
        return
      }

      respondWithFailure({ res, failure, isXml, code })
    }, delayMs)
  }
}

/**
 * Penangan dijalankan — efeknya tersimpan — tetapi jawabannya dibuang, dan
 * koneksinya ditahan sampai klien menyerah.
 *
 * `send` dan `json` diganti pada objek `res` permintaan INI saja; `end` tidak
 * disentuh supaya penahan waktu di bawah tetap dapat menutup koneksinya.
 * Alternatif yang ditolak: memutus soket setelah penangan selesai. Klien lalu
 * melihat `connection_reset`, bukan timeout — dan skenario US-05 yang diuji
 * Step 20 adalah timeout, yang oleh supplier-service ditangani lewat jalur
 * pencarian ulang yang berbeda.
 */
function loseResponse(req: Request, res: Response, next: NextFunction): void {
  res.send = () => res
  res.json = () => res
  holdUntilTimeout(req, res)
  next()
}

function holdUntilTimeout(req: Request, res: Response): void {
  const timer = setTimeout(() => {
    if (!res.headersSent) res.status(504).end()
  }, TIMEOUT_HOLD_MS)

  // Klien yang menyerah lebih dulu akan menutup koneksinya; tanpa pembersihan
  // ini, uji beban meninggalkan ribuan timer menggantung.
  req.on('close', () => {
    clearTimeout(timer)
  })
}

interface FailureResponse {
  readonly res: Response
  readonly failure: Exclude<FailureMode, 'connection_reset' | 'timeout'>
  readonly isXml: boolean
  readonly code: SupplierCode
}

function respondWithFailure(params: FailureResponse): void {
  const { res, failure, isXml, code } = params

  switch (failure) {
    case 'server_error':
      sendError(res, 500, code, isXml)
      return
    case 'unavailable':
      res.setHeader('retry-after', '5')
      sendError(res, 503, code, isXml)
      return
    case 'malformed':
      // Status 200 dengan isi yang tidak dapat diurai. Inilah yang membuat
      // validasi respons supplier pada Step 10 wajib: kegagalan ini tidak
      // terlihat dari kode status sama sekali.
      res.status(200).type(isXml ? 'text/xml' : 'application/json')
      res.send(isXml ? '<Envelope><Body><Unclosed>' : '{"results": [{"hotelId": ')
      return
    case 'truncated':
      res.status(200).type(isXml ? 'text/xml' : 'application/json')
      res.send(isXml ? '<Envelope><Body><AvailabilityResponse><Hotel><Cod' : '{"results":[{"hot')
      return
  }
}

function sendError(res: Response, status: number, code: SupplierCode, isXml: boolean): void {
  if (isXml) {
    res
      .status(status)
      .type('text/xml')
      .send(
        `<Envelope><Body><Fault><Code>${String(status)}</Code>` +
          `<Message>${code} upstream failure</Message></Fault></Body></Envelope>`,
      )
    return
  }

  res.status(status).json({ error: `${code}_UPSTREAM_FAILURE`, status })
}
