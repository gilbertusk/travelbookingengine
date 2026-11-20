'use client'

import { useQuery } from '@tanstack/react-query'
import { Alert, AlertDescription } from '@tbe/ui/alert'
import { Card, CardContent, CardHeader, CardTitle } from '@tbe/ui/card'
import { Input } from '@tbe/ui/input'
import { useState, type ReactNode } from 'react'
import { count, milliseconds, percent } from '@/lib/format'
import { opsRequest } from '@/lib/ops-client'
import { STAGE_LABELS, summarySchema, type AnalyticsReport as Report } from './schema'

/**
 * Laporan analitik. Rentang kosong = 30 hari terakhir (bawaan
 * analytics-service). Angka adalah agregat dari Kafka — bisa tertinggal
 * beberapa detik dari kejadian, dan itu wajar untuk sebuah konsumen.
 */
export function AnalyticsReport() {
  const [range, setRange] = useState({ from: '', to: '' })
  const query = new URLSearchParams(
    Object.entries(range).filter(([, value]) => /^\d{4}-\d{2}-\d{2}$/.test(value)),
  ).toString()
  const report = useQuery({
    queryKey: ['ops', 'analytics', query],
    queryFn: async () =>
      await opsRequest(
        summarySchema,
        'GET',
        `/analytics/summary${query === '' ? '' : `?${query}`}`,
      ),
  })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-3">
        {(['from', 'to'] as const).map((key) => (
          <div key={key} className="flex flex-col gap-1">
            <label htmlFor={`range-${key}`} className="text-caption text-muted-foreground">
              {key === 'from' ? 'Dari' : 'Sampai'}
            </label>
            <Input
              id={`range-${key}`}
              type="date"
              value={range[key]}
              onChange={(event) => {
                setRange({ ...range, [key]: event.target.value })
              }}
            />
          </div>
        ))}
      </div>
      {report.isError && (
        <Alert variant="destructive">
          <AlertDescription>{report.error.message}</AlertDescription>
        </Alert>
      )}
      {report.data === undefined ? (
        !report.isError && <p className="text-muted-foreground">Memuat…</p>
      ) : (
        <ReportBody report={report.data} />
      )}
    </div>
  )
}

function ReportBody({ report }: { readonly report: Report }) {
  const { summary } = report
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Section title={`Corong (${report.range.from} – ${report.range.to})`}>
        {summary.funnel.map((stage) => (
          <Row key={stage.stage} label={STAGE_LABELS[stage.stage] ?? stage.stage}>
            {count(stage.count)} · {percent(stage.fromPreviousBasisPoints)} dari tahap sebelumnya
          </Row>
        ))}
        <Row label="Rata-rata latensi pencarian">
          {milliseconds(summary.search.averageLatencyMs)}
        </Row>
      </Section>
      <Section title="Kegagalan pemesanan">
        <Row label="Tingkat kegagalan">
          {percent(summary.failures.failureRateBasisPoints)} (
          {count(summary.failures.bookingsFailed)} dari {count(summary.failures.bookingsCreated)})
        </Row>
        {summary.failures.byCause.map((cause) => (
          <Row key={`${cause.stage}|${cause.reason}`} label={`${cause.stage}: ${cause.reason}`}>
            {count(cause.count)}
          </Row>
        ))}
      </Section>
      <Section title="Performa supplier">
        {summary.suppliers.map((row) => (
          <Row key={row.supplier} label={row.supplier}>
            menjawab {percent(row.responseRateBasisPoints)} dari {count(row.searchesAsked)} ·
            perubahan harga {percent(row.priceChangeRateBasisPoints)} · gagal{' '}
            {count(row.bookingsFailed)} · tidak pasti {count(row.confirmUncertain)} · terdegradasi{' '}
            {count(row.degradedTimes)}×
          </Row>
        ))}
      </Section>
      <Section title="Kota dan rentang terpopuler">
        {summary.topCities.map((city) => (
          <Row key={city.city} label={city.city}>
            {count(city.searches)} pencarian
          </Row>
        ))}
        {summary.topStays.map((stay) => (
          <Row
            key={`${stay.city}${stay.checkIn}${stay.checkOut}`}
            label={`${stay.city} ${stay.checkIn} → ${stay.checkOut}`}
          >
            {count(stay.searches)}
          </Row>
        ))}
      </Section>
    </div>
  )
}

function Section(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{props.title}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="flex flex-col gap-1 text-small">{props.children}</dl>
      </CardContent>
    </Card>
  )
}

function Row(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b py-1 last:border-b-0">
      <dt className="text-muted-foreground">{props.label}</dt>
      <dd className="text-right" data-numeric>
        {props.children}
      </dd>
    </div>
  )
}
