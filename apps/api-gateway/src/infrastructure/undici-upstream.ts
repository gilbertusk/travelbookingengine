import { Readable } from 'node:stream'
import { request } from 'undici'
import type { Upstream, UpstreamOutcome, UpstreamRequest } from '../application/ports.js'
import type { ServiceName } from '../domain/routes.js'

/**
 * Klien hulu berbasis undici.
 *
 * Kegagalan dipetakan menjadi dua jenis yang harus dibedakan klien: batas
 * waktu terlampaui, dan tidak dapat dihubungi. Menyatukannya menjadi satu
 * "gagal" membuat gateway tidak dapat memberi tahu apakah permintaan mungkin
 * sudah dikerjakan hulu — dan itu perbedaan yang menentukan apakah aman
 * mencobanya lagi.
 */

export type ServiceUrls = Readonly<Record<ServiceName, string>>

const PROBE_TIMEOUT_MS = 2_000

export function createUndiciUpstream(urls: ServiceUrls): Upstream {
  return {
    async send(outbound: UpstreamRequest): Promise<UpstreamOutcome> {
      try {
        const response = await request(`${urls[outbound.service]}${outbound.path}`, {
          method: outbound.method as 'GET',
          headers: outbound.headers,
          ...(outbound.body === undefined ? {} : { body: outbound.body }),
          headersTimeout: outbound.timeoutMs,
          bodyTimeout: outbound.timeoutMs,
        })

        return {
          kind: 'response',
          statusCode: response.statusCode,
          headers: response.headers,
          body: Readable.from(response.body),
        }
      } catch (error) {
        return { kind: classifyFailure(error) }
      }
    },

    async probe(service: ServiceName): Promise<boolean> {
      try {
        const response = await request(`${urls[service]}/health/live`, {
          method: 'GET',
          headersTimeout: PROBE_TIMEOUT_MS,
          bodyTimeout: PROBE_TIMEOUT_MS,
        })

        // Badan respons harus dihabiskan; membiarkannya menggantung membuat
        // koneksi tidak pernah kembali ke pool, dan probe berikutnya melambat
        // sampai akhirnya habis.
        await response.body.dump()
        return response.statusCode < 500
      } catch {
        return false
      }
    },
  }
}

export function classifyFailure(error: unknown): 'timeout' | 'unreachable' {
  const code = errorCode(error)

  return code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
    ? 'timeout'
    : 'unreachable'
}

function errorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null) return ''

  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : ''
}
