'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, AlertDescription } from '@tbe/ui/alert'
import { Button } from '@tbe/ui/button'
import { Input } from '@tbe/ui/input'
import { useState } from 'react'
import { z } from 'zod'
import { opsRequest } from '@/lib/ops-client'
import { supplierHealthListSchema, type SupplierHealth } from './schema'

/**
 * Konfigurasi supplier (FR-29): aktif/nonaktif dan ambang pemutus. Menulis
 * lewat `PATCH /ops/suppliers/:code` — rute yang sama dengan yang dipakai
 * supplier-service secara internal, di balik `requireOperator`.
 */
export function SupplierSettingsForm() {
  const suppliers = useQuery({
    queryKey: ['ops', 'suppliers'],
    queryFn: async () => await opsRequest(supplierHealthListSchema, 'GET', '/suppliers'),
  })

  if (suppliers.isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{suppliers.error.message}</AlertDescription>
      </Alert>
    )
  }
  if (suppliers.data === undefined) return <p className="text-muted-foreground">Memuat…</p>

  return (
    <ul className="flex flex-col gap-3">
      {suppliers.data.map((supplier) => (
        <SupplierRow key={supplier.code} supplier={supplier} />
      ))}
    </ul>
  )
}

function SupplierRow({ supplier }: { readonly supplier: SupplierHealth }) {
  const queryClient = useQueryClient()
  const [threshold, setThreshold] = useState(String(supplier.settings.circuit.failureThreshold))
  const update = useMutation({
    mutationFn: async (patch: object) =>
      await opsRequest(z.unknown(), 'PATCH', `/suppliers/${supplier.code}`, { body: patch }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['ops', 'suppliers'] })
    },
  })
  const parsedThreshold = Number.parseInt(threshold, 10)
  const isThresholdValid = Number.isInteger(parsedThreshold) && parsedThreshold > 0
  const inputId = `ambang-${supplier.code}`

  return (
    <li className="flex flex-wrap items-end gap-3 rounded-lg border p-3">
      <span className="w-24 font-medium">{supplier.code}</span>
      <Button
        size="sm"
        variant={supplier.isActive ? 'secondary' : 'primary'}
        disabled={update.isPending}
        onClick={() => {
          update.mutate({ isActive: !supplier.isActive })
        }}
      >
        {supplier.isActive ? 'Nonaktifkan' : 'Aktifkan'}
      </Button>
      <div className="flex flex-col gap-1">
        <label htmlFor={inputId} className="text-caption text-muted-foreground">
          Ambang kegagalan pemutus
        </label>
        <Input
          id={inputId}
          className="w-28"
          inputMode="numeric"
          value={threshold}
          onChange={(event) => {
            setThreshold(event.target.value)
          }}
        />
      </div>
      <Button
        size="sm"
        disabled={!isThresholdValid || update.isPending}
        onClick={() => {
          update.mutate({ circuit: { failureThreshold: parsedThreshold } })
        }}
      >
        Simpan ambang
      </Button>
      {update.isError && (
        <span className="text-small text-destructive">{update.error.message}</span>
      )}
    </li>
  )
}
