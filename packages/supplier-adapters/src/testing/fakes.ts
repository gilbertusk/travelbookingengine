import { readFileSync } from 'node:fs'
import { ok, type Result } from '@tbe/shared-kernel'
import type { SupplierError } from '../errors/supplier-error.js'
import type { HttpRequest, HttpResponse, SupplierHttp } from '../http/client.js'

/**
 * Perkakas uji adapter.
 *
 * Yang dipalsukan hanya transport. Penguraian, validasi, dan normalisasi —
 * seluruh isi adapter — dijalankan sungguhan terhadap respons yang benar-benar
 * pernah dikirim mock-supplier.
 */

export function readFixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
}

export interface RecordedCall {
  readonly request: HttpRequest
}

export interface FakeHttp extends SupplierHttp {
  readonly calls: RecordedCall[]
}

export function respondWith(
  text: string,
  options: {
    readonly status?: number
    readonly headers?: Readonly<Record<string, string>>
  } = {},
): HttpResponse {
  return { status: options.status ?? 200, headers: options.headers ?? {}, text }
}

/** Menjawab setiap permintaan dengan respons yang sama. */
export function fakeHttp(response: HttpResponse | SupplierError): FakeHttp {
  const calls: RecordedCall[] = []

  return {
    calls,
    async send(request: HttpRequest): Promise<Result<HttpResponse, SupplierError>> {
      calls.push({ request })

      return await Promise.resolve(
        'kind' in response ? { ok: false, error: response } : ok(response),
      )
    },
  }
}

/** Menjawab berurutan, untuk alur yang memanggil supplier lebih dari sekali. */
export function fakeHttpSequence(responses: readonly HttpResponse[]): FakeHttp {
  const calls: RecordedCall[] = []
  let index = 0

  return {
    calls,
    async send(request: HttpRequest): Promise<Result<HttpResponse, SupplierError>> {
      calls.push({ request })
      const response = responses[Math.min(index, responses.length - 1)]
      index += 1

      if (response === undefined) throw new Error('tidak ada respons yang disiapkan')

      return await Promise.resolve(ok(response))
    },
  }
}
