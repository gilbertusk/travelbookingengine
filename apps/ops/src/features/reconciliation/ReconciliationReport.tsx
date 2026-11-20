'use client'

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { Alert, AlertDescription } from '@tbe/ui/alert'
import { Badge } from '@tbe/ui/badge'
import { Button } from '@tbe/ui/button'
import { count, dateTime } from '@/lib/format'
import { opsRequest } from '@/lib/ops-client'
import {
  FINDING_LABELS,
  reconciliationSchema,
  runRequestedSchema,
  type ReconciliationRun,
} from './schema'

/**
 * Laporan rekonsiliasi (Step 28, FR-33).
 *
 * Panel hanya MELAPORKAN. Tidak ada tombol "perbaiki" di sini, dan itu
 * disengaja: pemesanan yang tidak cocok sudah dipindahkan ke antrean
 * tinjauan, dan keputusan atas uang dan kamar diambil di sana, satu per satu,
 * oleh manusia yang membaca jejaknya. Satu-satunya tindakan adalah meminta
 * putaran baru — misalnya setelah supplier pulih.
 */

const KEY = ['ops', 'reconciliation']

export function ReconciliationReport() {
  const report = useQuery({
    queryKey: KEY,
    queryFn: async () => await opsRequest(reconciliationSchema, 'GET', '/bookings/reconciliation'),
    refetchInterval: 15_000,
  })
  const queryClient = useQueryClient()
  const run = useMutation({
    mutationFn: async () =>
      await opsRequest(runRequestedSchema, 'POST', '/bookings/reconciliation/run', { body: {} }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: KEY })
    },
  })

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          disabled={run.isPending}
          onClick={() => {
            run.mutate()
          }}
        >
          Jalankan rekonsiliasi sekarang
        </Button>
        {run.isSuccess && (
          <p className="text-small text-muted-foreground" role="status">
            Putaran {run.data.runId} diminta. Hasilnya muncul di bawah begitu selesai.
          </p>
        )}
        {run.isError && <p className="text-small text-destructive">{run.error.message}</p>}
      </div>
      <Runs state={report} />
    </div>
  )
}

function Runs({ state }: { readonly state: UseQueryResult<ReconciliationRun[]> }) {
  if (state.isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{state.error.message}</AlertDescription>
      </Alert>
    )
  }
  if (state.data === undefined) return <p className="text-muted-foreground">Memuat…</p>
  if (state.data.length === 0) {
    return <p className="text-muted-foreground">Belum ada putaran rekonsiliasi.</p>
  }

  return (
    <ul className="flex flex-col gap-4">
      {state.data.map((item) => (
        <RunCard key={item.id} run={item} />
      ))}
    </ul>
  )
}

function RunCard({ run }: { readonly run: ReconciliationRun }) {
  return (
    <li className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{dateTime(run.startedAt)}</span>
        <span className="text-small text-muted-foreground">
          {run.supplier === null ? 'seluruh supplier' : `supplier ${run.supplier}`}
        </span>
        {run.finishedAt === null ? (
          <Badge variant="warning">Berjalan atau terhenti</Badge>
        ) : run.flagged > 0 ? (
          <Badge variant="destructive">{count(run.flagged)} ditandai untuk tinjauan</Badge>
        ) : (
          <Badge variant="success">Cocok</Badge>
        )}
      </div>
      <p className="text-small text-muted-foreground">
        Diperiksa {count(run.checked)} · cocok {count(run.matched)} · tidak cocok{' '}
        {count(run.mismatched)} · tidak dapat diperiksa {count(run.unverified)}
      </p>
      {run.findings.length > 0 && <Findings run={run} />}
    </li>
  )
}

function Findings({ run }: { readonly run: ReconciliationRun }) {
  return (
    <table className="w-full text-small">
      <caption className="sr-only">Temuan putaran {run.id}</caption>
      <thead className="text-left text-muted-foreground">
        <tr>
          <th className="p-2">Temuan</th>
          <th className="p-2">Pemesanan</th>
          <th className="p-2">Di sistem</th>
          <th className="p-2">Rincian</th>
          <th className="p-2">Tinjauan</th>
        </tr>
      </thead>
      <tbody>
        {run.findings.map((finding) => (
          <tr key={finding.bookingId} className="border-t align-top">
            <td className="p-2">{FINDING_LABELS[finding.kind]}</td>
            <td className="p-2 font-mono text-caption">{finding.bookingId}</td>
            <td className="p-2">{finding.localStatus}</td>
            <td className="p-2">{finding.detail}</td>
            <td className="p-2">
              {finding.flagged
                ? 'Ditandai'
                : finding.kind === 'unverified'
                  ? 'Diperiksa lagi putaran berikutnya'
                  : 'Pemesanan bergerak sebelum ditandai'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
