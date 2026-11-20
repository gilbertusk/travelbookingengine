import type { GatewayPort, GatewayReply, GatewayRequest } from '@/lib/gateway'

/** Gateway palsuan: jawaban per `METHOD path`, dan catatan setiap permintaan. */
export interface ScriptedGateway extends GatewayPort {
  readonly calls: GatewayRequest[]
}

export function scriptedGateway(
  answers: Readonly<Record<string, GatewayReply | readonly GatewayReply[]>>,
): ScriptedGateway {
  const calls: GatewayRequest[] = []
  const queues = new Map<string, GatewayReply[]>(
    Object.entries(answers).map(([key, value]) => [key, isList(value) ? [...value] : [value]]),
  )
  return {
    calls,
    async send(request) {
      await Promise.resolve()
      calls.push(request)
      const queue = queues.get(`${request.method} ${request.path}`) ?? []
      const next = queue.length > 1 ? queue.shift() : queue[0]
      if (next === undefined)
        throw new Error(`tidak ada jawaban untuk ${request.method} ${request.path}`)
      return next
    },
  }
}

export const ok = (data: unknown, status = 200): GatewayReply => ({
  status,
  payload: { data, error: null },
})

export const failed = (status: number, code = 'X'): GatewayReply => ({
  status,
  payload: { data: null, error: { code, message: code } },
})

export const TOKENS = { accessToken: 'akses-baru', refreshToken: 'segar-baru', expiresIn: 900 }

function isList(value: GatewayReply | readonly GatewayReply[]): value is readonly GatewayReply[] {
  return !('status' in value)
}
