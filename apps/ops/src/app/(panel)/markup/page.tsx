import type { Metadata } from 'next'
import { MarkupRuleForm } from '@/features/markup/MarkupRuleForm'
import { MarkupRuleList } from '@/features/markup/MarkupRuleList'

export const metadata: Metadata = { title: 'Aturan markup' }

export default function Page() {
  return (
    <>
      <h1 className="text-h2">Aturan markup</h1>
      <MarkupRuleList />
      <h2 className="text-h3">Aturan baru</h2>
      <MarkupRuleForm />
    </>
  )
}
