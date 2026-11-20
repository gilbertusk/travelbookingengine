'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Alert, AlertDescription } from '@tbe/ui/alert'
import { Button } from '@tbe/ui/button'
import { Input } from '@tbe/ui/input'
import { useState, type ReactNode } from 'react'
import { z } from 'zod'
import { opsRequest } from '@/lib/ops-client'
import { RULES_KEY } from './MarkupRuleList'
import { PreviewTable } from './PreviewTable'
import { SUPPLIERS, previewSchema, ruleBodyOf, samplesFor, type RuleDraft } from './schema'

/**
 * Aturan baru dengan PRATINJAU DAMPAK sebelum disimpan (FR-30). Pratinjau
 * dihitung pricing-service dengan mesin yang sama dengan pencarian, atas satu
 * sampel per supplier di kota dan harga supplier yang dipilih operator.
 * Tombol simpan baru aktif setelah pratinjau terakhir cocok dengan isian.
 */
export function MarkupRuleForm() {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<RuleDraft>({
    name: '',
    priority: 0,
    city: '',
    supplier: '',
    percent: '',
  })
  const [sample, setSample] = useState({ city: 'Bali', amount: '1000000' })
  const body = ruleBodyOf(draft)
  const amountMinor = Number.parseInt(sample.amount, 10)

  const preview = useMutation({
    mutationFn: async () =>
      await opsRequest(previewSchema, 'POST', '/pricing/markup-rules/preview', {
        body: {
          change: { kind: 'create', rule: body },
          samples: samplesFor(sample.city, amountMinor),
        },
      }),
  })
  const save = useMutation({
    mutationFn: async () =>
      await opsRequest(z.unknown(), 'POST', '/pricing/markup-rules', { body }),
    onSuccess: async () => {
      preview.reset()
      await queryClient.invalidateQueries({ queryKey: RULES_KEY })
    },
  })
  const edit = (patch: Partial<RuleDraft>) => {
    setDraft({ ...draft, ...patch })
    preview.reset()
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 md:grid-cols-5">
        <Labeled label="Nama" id="rule-name">
          <Input
            id="rule-name"
            value={draft.name}
            onChange={(e) => {
              edit({ name: e.target.value })
            }}
          />
        </Labeled>
        <Labeled label="Markup (%)" id="rule-percent">
          <Input
            id="rule-percent"
            inputMode="decimal"
            value={draft.percent}
            onChange={(e) => {
              edit({ percent: e.target.value })
            }}
          />
        </Labeled>
        <Labeled label="Kota (kosong = semua)" id="rule-city">
          <Input
            id="rule-city"
            value={draft.city}
            onChange={(e) => {
              edit({ city: e.target.value })
            }}
          />
        </Labeled>
        <Labeled label="Supplier" id="rule-supplier">
          <select
            id="rule-supplier"
            className="h-11 rounded-md border bg-card px-2 text-body text-foreground"
            value={draft.supplier}
            onChange={(e) => {
              edit({ supplier: e.target.value })
            }}
          >
            <option value="">semua</option>
            {SUPPLIERS.map((code) => (
              <option key={code}>{code}</option>
            ))}
          </select>
        </Labeled>
        <Labeled label="Prioritas" id="rule-priority">
          <Input
            id="rule-priority"
            inputMode="numeric"
            value={String(draft.priority)}
            onChange={(e) => {
              edit({ priority: Number.parseInt(e.target.value, 10) || 0 })
            }}
          />
        </Labeled>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Labeled label="Kota sampel" id="sample-city">
          <Input
            id="sample-city"
            value={sample.city}
            onChange={(e) => {
              setSample({ ...sample, city: e.target.value })
            }}
          />
        </Labeled>
        <Labeled label="Harga supplier sampel (IDR)" id="sample-amount">
          <Input
            id="sample-amount"
            inputMode="numeric"
            value={sample.amount}
            onChange={(e) => {
              setSample({ ...sample, amount: e.target.value })
            }}
          />
        </Labeled>
        <Button
          disabled={body === undefined || !(amountMinor > 0) || preview.isPending}
          onClick={() => {
            preview.mutate()
          }}
        >
          Pratinjau dampak
        </Button>
        <Button
          variant="primary"
          disabled={preview.data === undefined || save.isPending}
          onClick={() => {
            save.mutate()
          }}
        >
          Simpan aturan
        </Button>
      </div>
      {(preview.error ?? save.error) !== null && (
        <Alert variant="destructive">
          <AlertDescription>{(preview.error ?? save.error)?.message}</AlertDescription>
        </Alert>
      )}
      {preview.data !== undefined && <PreviewTable preview={preview.data} />}
    </div>
  )
}

function Labeled(props: {
  readonly label: string
  readonly id: string
  readonly children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={props.id} className="text-caption text-muted-foreground">
        {props.label}
      </label>
      {props.children}
    </div>
  )
}
