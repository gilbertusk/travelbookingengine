import type { Metadata } from 'next'
import { SupplierHealthTable } from '@/features/suppliers/SupplierHealthTable'

export const metadata: Metadata = { title: 'Kesehatan supplier' }

export default function Page() {
  return (
    <>
      <h1 className="text-h2">Kesehatan supplier</h1>
      <p className="text-small text-muted-foreground">
        Pemutus per operasi dan statistik lima belas menit terakhir, diperbarui setiap tiga detik.
      </p>
      <SupplierHealthTable />
    </>
  )
}
