import type { Metadata } from 'next'
import { MockSupplierControl } from '@/features/control/MockSupplierControl'

export const metadata: Metadata = { title: 'Kendali mock supplier' }

export default function Page() {
  return (
    <>
      <h1 className="text-h2">Kendali mock supplier</h1>
      <MockSupplierControl />
    </>
  )
}
