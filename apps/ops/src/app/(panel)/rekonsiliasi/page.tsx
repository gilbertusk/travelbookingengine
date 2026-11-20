import type { Metadata } from 'next'
import { ReconciliationReport } from '@/features/reconciliation/ReconciliationReport'

export const metadata: Metadata = { title: 'Rekonsiliasi' }

export default function Page() {
  return (
    <>
      <h1 className="text-h2">Rekonsiliasi dengan supplier</h1>
      <ReconciliationReport />
    </>
  )
}
