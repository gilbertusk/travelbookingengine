import type { ZodType } from 'zod'

/**
 * Panggilan dari halaman ke rute server panel ini (`/api/ops/...`).
 *
 * Halaman tidak pernah memegang token dan tidak pernah tahu alamat gateway.
 * Jawaban DIVALIDASI dengan skema: panel operator membaca data yang dipakai
 * untuk memutuskan nasib uang pengguna, dan bidang yang diam-diam berganti
 * nama di service tidak boleh tampil sebagai "kosong" yang tampak sah.
 */

export class OpsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'OpsError'
  }
}

export type OpsMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

export interface Navigator {
  toLogin(): void
}

const browserNavigator: Navigator = {
  toLogin: () => {
    window.location.assign('/masuk')
  },
}

export async function opsRequest<T>(
  schema: ZodType<T>,
  method: OpsMethod,
  path: string,
  options: {
    readonly body?: unknown
    readonly navigator?: Navigator
    /**
     * `false` untuk mock supplier: panel kendalinya memerankan sistem pihak
     * luar dan menjawab JSON mentah, tanpa amplop `{ data, error }` milik
     * service kita.
     */
    readonly isEnveloped?: boolean
  } = {},
): Promise<T> {
  const response = await fetch(`/api/ops${path}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  const payload: unknown = await response.json().catch(() => null)

  if (response.status === 401) (options.navigator ?? browserNavigator).toLogin()
  if (!response.ok) throw errorOf(response.status, payload)

  const parsed = schema.safeParse(options.isEnveloped === false ? payload : dataOf(payload))
  if (!parsed.success) {
    throw new OpsError(502, 'UNEXPECTED_SHAPE', 'Jawaban service tidak sesuai bentuk yang dikenal.')
  }
  return parsed.data
}

function dataOf(payload: unknown): unknown {
  return typeof payload === 'object' && payload !== null && 'data' in payload
    ? payload.data
    : undefined
}

function errorOf(status: number, payload: unknown): OpsError {
  const error =
    typeof payload === 'object' && payload !== null && 'error' in payload ? payload.error : null
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'UNKNOWN'
  const message =
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
      ? error.message
      : 'Permintaan gagal.'
  return new OpsError(status, code, message)
}
