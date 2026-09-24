import { err, ok, type Result } from '@tbe/shared-kernel'
import type { z } from 'zod'
import type { SupplierCode } from '../canonical/model.js'
import type { SupplierError } from '../errors/supplier-error.js'
import type { HttpResponse, Operation } from '../http/client.js'
import { invalidResponse, mapHttpFailure } from '../http/failure.js'

/**
 * Langkah yang sama pada kelima adapter.
 *
 * Urutannya selalu: periksa status, urai badan respons, validasi terhadap
 * skema, baru normalisasi. Melewati langkah ketiga adalah yang membuat mode
 * kegagalan `malformed` berbahaya — status 200 dengan isi yang tidak dapat
 * dipercaya lolos begitu saja dan baru meledak di tempat lain, jauh dari
 * penyebabnya.
 */

export interface AdapterContext {
  readonly supplier: SupplierCode
  readonly operation: Operation
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/**
 * Respons berhasil yang sudah tervalidasi.
 *
 * Mengembalikan Err untuk status non-2xx maupun untuk isi yang tidak lolos
 * skema. Kode galat digali pemanggil dari badan respons, karena letaknya
 * berbeda pada setiap supplier.
 */
export function decodeJson<T>(
  context: AdapterContext,
  response: HttpResponse,
  schema: z.ZodType<T>,
  errorCodeOf: (body: unknown) => string | undefined,
): Result<T, SupplierError> {
  const body = parseJson(response.text)

  if (response.status < 200 || response.status >= 300) {
    return err(mapHttpFailure({ ...context, response, code: errorCodeOf(body) }))
  }

  if (body === undefined) {
    // Mode kegagalan `malformed` dan `truncated` keduanya membalas 200.
    return err(invalidResponse(context.supplier, context.operation, 'badan respons bukan JSON'))
  }

  return validate(context, schema, body)
}

export function validate<T>(
  context: AdapterContext,
  schema: z.ZodType<T>,
  value: unknown,
): Result<T, SupplierError> {
  const parsed = schema.safeParse(value)

  return parsed.success
    ? ok(parsed.data)
    : err(invalidResponse(context.supplier, context.operation, describeIssues(parsed.error)))
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join('.') || '(akar)'}: ${issue.message}`)
    .join('; ')
}
