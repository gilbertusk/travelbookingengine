import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, type RenderResult } from '@testing-library/react'
import type { ReactElement } from 'react'
import { vi } from 'vitest'

/**
 * Render dengan QueryClient tanpa percobaan ulang dan `fetch` palsuan yang
 * menjawab per `METHOD /api/...`. Permintaan tercatat beserta badannya —
 * yang diuji adalah apa yang DIKIRIM halaman ke rute server, bukan
 * implementasi komponennya.
 */

export interface FetchCall {
  readonly method: string
  readonly url: string
  readonly body: unknown
}

type Answer = { readonly status?: number; readonly body: unknown }

export function fakeFetch(
  answers: Readonly<Record<string, Answer | ((call: FetchCall) => Answer)>>,
) {
  const calls: FetchCall[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    await Promise.resolve()
    const url = input instanceof Request ? input.url : input.toString()
    const method = init?.method ?? 'GET'
    const raw = init?.body
    const body: unknown = typeof raw === 'string' ? JSON.parse(raw) : undefined
    const call: FetchCall = { method, url, body }
    calls.push(call)
    const answer = answers[`${method} ${url}`] ?? answers[`${method} ${url.split('?')[0] ?? url}`]
    const resolved = typeof answer === 'function' ? answer(call) : answer
    if (resolved === undefined) return new Response(JSON.stringify({ data: null }), { status: 404 })
    return new Response(JSON.stringify(resolved.body), { status: resolved.status ?? 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { calls }
}

export function envelope(data: unknown): Answer {
  return { body: { data, error: null } }
}

export function renderWithQuery(element: ReactElement): RenderResult {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>)
}
