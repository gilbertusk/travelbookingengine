import type { Metadata } from 'next'
import { ReviewQueue } from '@/features/review/ReviewQueue'

export const metadata: Metadata = { title: 'Tinjauan NEEDS_REVIEW' }

export default function Page() {
  return (
    <>
      <h1 className="text-h2">Tinjauan NEEDS_REVIEW</h1>
      <ReviewQueue />
    </>
  )
}
