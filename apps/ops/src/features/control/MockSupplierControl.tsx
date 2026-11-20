'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, AlertDescription } from '@tbe/ui/alert'
import { Badge } from '@tbe/ui/badge'
import { Button } from '@tbe/ui/button'
import { Input } from '@tbe/ui/input'
import { useState } from 'react'
import { z } from 'zod'
import { percent } from '@/lib/format'
import { opsRequest } from '@/lib/ops-client'
import { FAILURE_MODES, mockStateSchema, type MockSupplier } from './schema'

/**
 * Panel kendali mock supplier (FR-32) — alat utama saat demo: matikan satu
 * supplier di depan penilai, lalu tunjukkan pencarian tetap berjalan dan
 * pemesanan tetap direfund. Setiap tombol memanggil rute `/admin` mock
 * supplier lewat `/ops/mock-supplier`, di balik `requireOperator`.
 */

const KEY = ['ops', 'mock-supplier']

function useControl() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ path, body }: { readonly path: string; readonly body?: unknown }) =>
      await opsRequest(z.unknown(), 'POST', `/mock-supplier${path}`, {
        body: body ?? {},
        isEnveloped: false,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: KEY })
      await queryClient.invalidateQueries({ queryKey: ['ops', 'suppliers'] })
    },
  })
}

export function MockSupplierControl() {
  const state = useQuery({
    queryKey: KEY,
    queryFn: async () =>
      await opsRequest(mockStateSchema, 'GET', '/mock-supplier/state', { isEnveloped: false }),
  })
  const control = useControl()

  if (state.isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          Mock supplier tidak dapat dihubungi: {state.error.message}
        </AlertDescription>
      </Alert>
    )
  }
  if (state.data === undefined) return <p className="text-muted-foreground">Memuat…</p>

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button
          variant="secondary"
          size="sm"
          disabled={control.isPending}
          onClick={() => {
            control.mutate({ path: '/reset' })
          }}
        >
          Pulihkan semua supplier
        </Button>
      </div>
      {control.isError && <p className="text-small text-destructive">{control.error.message}</p>}
      <ul className="flex flex-col gap-3">
        {state.data.suppliers.map((supplier) => (
          <SupplierControl key={supplier.code} supplier={supplier} />
        ))}
      </ul>
    </div>
  )
}

function SupplierControl({ supplier }: { readonly supplier: MockSupplier }) {
  const control = useControl()
  const [rate, setRate] = useState('50')
  const [mode, setMode] = useState<(typeof FAILURE_MODES)[number]>('server_error')
  const [latency, setLatency] = useState('2000')
  const path = `/${supplier.code.toLowerCase()}`
  const rateValue = Number(rate) / 100
  const latencyValue = Number.parseInt(latency, 10)

  return (
    <li className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex items-center gap-3">
        <span className="w-20 font-medium">{supplier.code}</span>
        <StatusBadges supplier={supplier} />
        <Button
          size="sm"
          variant={supplier.chaos.down ? 'primary' : 'destructive'}
          disabled={control.isPending}
          onClick={() => {
            control.mutate({ path: `${path}/${supplier.chaos.down ? 'up' : 'down'}` })
          }}
        >
          {supplier.chaos.down ? 'Nyalakan' : 'Matikan'}
        </Button>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <LabeledInput
          id={`rate-${supplier.code}`}
          label="Kegagalan (%)"
          value={rate}
          onChange={setRate}
        />
        <label className="flex flex-col gap-1 text-caption text-muted-foreground">
          Mode
          <select
            className="h-9 rounded-md border bg-card px-2 text-small text-foreground"
            value={mode}
            onChange={(event) => {
              const next = FAILURE_MODES.find((candidate) => candidate === event.target.value)
              if (next !== undefined) setMode(next)
            }}
          >
            {FAILURE_MODES.map((candidate) => (
              <option key={candidate} value={candidate}>
                {candidate}
              </option>
            ))}
          </select>
        </label>
        <Button
          size="sm"
          disabled={control.isPending || !(rateValue >= 0 && rateValue <= 1)}
          onClick={() => {
            control.mutate({ path: `${path}/failure`, body: { rate: rateValue, mode } })
          }}
        >
          Suntik kegagalan
        </Button>
        <LabeledInput
          id={`latency-${supplier.code}`}
          label="Latensi (ms)"
          value={latency}
          onChange={setLatency}
        />
        <Button
          size="sm"
          disabled={control.isPending || !(latencyValue >= 0)}
          onClick={() => {
            control.mutate({
              path: `${path}/latency`,
              body: { min: latencyValue, max: latencyValue },
            })
          }}
        >
          Suntik latensi
        </Button>
      </div>
    </li>
  )
}

function StatusBadges({ supplier }: { readonly supplier: MockSupplier }) {
  const { chaos } = supplier
  return (
    <span className="flex flex-wrap gap-1">
      {chaos.down ? (
        <Badge variant="destructive">MATI</Badge>
      ) : (
        <Badge variant="success">hidup</Badge>
      )}
      {chaos.failureRate !== undefined && (
        <Badge variant="warning">
          gagal {percent(Math.round(chaos.failureRate * 10_000))} · {chaos.failureMode}
        </Badge>
      )}
      {chaos.latencyMs !== undefined && (
        <Badge variant="warning">
          latensi {chaos.latencyMs[0]}–{chaos.latencyMs[1]} ms
        </Badge>
      )}
    </span>
  )
}

function LabeledInput(props: {
  readonly id: string
  readonly label: string
  readonly value: string
  readonly onChange: (value: string) => void
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={props.id} className="text-caption text-muted-foreground">
        {props.label}
      </label>
      <Input
        id={props.id}
        className="w-24"
        inputMode="numeric"
        value={props.value}
        onChange={(event) => {
          props.onChange(event.target.value)
        }}
      />
    </div>
  )
}
