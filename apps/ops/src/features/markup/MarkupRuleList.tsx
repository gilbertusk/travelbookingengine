'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, AlertDescription } from '@tbe/ui/alert'
import { Badge } from '@tbe/ui/badge'
import { Button } from '@tbe/ui/button'
import { z } from 'zod'
import { money, percent } from '@/lib/format'
import { opsRequest } from '@/lib/ops-client'
import { markupRuleSchema, type MarkupRule } from './schema'

export const RULES_KEY = ['ops', 'markup-rules']

/** Daftar aturan markup (FR-30). Menghapus = menonaktifkan; harga lama merujuk aturannya. */
export function MarkupRuleList() {
  const rules = useQuery({
    queryKey: RULES_KEY,
    queryFn: async () =>
      await opsRequest(z.array(markupRuleSchema), 'GET', '/pricing/markup-rules'),
  })

  if (rules.isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{rules.error.message}</AlertDescription>
      </Alert>
    )
  }
  if (rules.data === undefined) return <p className="text-muted-foreground">Memuat…</p>
  if (rules.data.length === 0) return <p className="text-muted-foreground">Belum ada aturan.</p>

  return (
    <table className="w-full text-small">
      <caption className="sr-only">Aturan markup</caption>
      <thead className="text-left text-muted-foreground">
        <tr>
          <th className="p-2">Nama</th>
          <th className="p-2">Cakupan</th>
          <th className="p-2">Markup</th>
          <th className="p-2">Prioritas</th>
          <th className="p-2">Status</th>
          <th className="p-2">
            <span className="sr-only">Aksi</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rules.data.map((rule) => (
          <RuleRow key={rule.id} rule={rule} />
        ))}
      </tbody>
    </table>
  )
}

function RuleRow({ rule }: { readonly rule: MarkupRule }) {
  const queryClient = useQueryClient()
  const change = useMutation({
    mutationFn: async (isActive: boolean) =>
      isActive
        ? await opsRequest(z.unknown(), 'PATCH', `/pricing/markup-rules/${rule.id}`, {
            body: { isActive: true },
          })
        : await opsRequest(z.unknown(), 'DELETE', `/pricing/markup-rules/${rule.id}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: RULES_KEY })
    },
  })

  return (
    <tr className="border-t">
      <td className="p-2 font-medium">{rule.name}</td>
      <td className="p-2">
        {[rule.scope.supplier, rule.scope.city].filter(Boolean).join(' · ') || 'global'}
      </td>
      <td className="p-2" data-numeric>
        {rule.kind === 'percentage'
          ? percent(rule.percentageBasisPoints ?? null)
          : rule.fixedAmount === undefined
            ? '—'
            : money(rule.fixedAmount)}
      </td>
      <td className="p-2" data-numeric>
        {rule.priority}
      </td>
      <td className="p-2">
        {rule.isActive ? <Badge variant="success">aktif</Badge> : <Badge>nonaktif</Badge>}
      </td>
      <td className="p-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={change.isPending}
          onClick={() => {
            change.mutate(!rule.isActive)
          }}
        >
          {rule.isActive ? 'Nonaktifkan' : 'Aktifkan'}
        </Button>
      </td>
    </tr>
  )
}
