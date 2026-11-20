import type { Metadata } from 'next'
import { AnalyticsReport } from '@/features/analytics/AnalyticsReport'

export const metadata: Metadata = { title: 'Analitik' }

export default function Page() {
  return (
    <>
      <h1 className="text-h2">Analitik</h1>
      <AnalyticsReport />
    </>
  )
}
