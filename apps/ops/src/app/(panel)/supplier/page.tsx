import type { Metadata } from 'next'
import { SupplierSettingsForm } from '@/features/suppliers/SupplierSettingsForm'

export const metadata: Metadata = { title: 'Konfigurasi supplier' }

export default function Page() {
  return (
    <>
      <h1 className="text-h2">Konfigurasi supplier</h1>
      <SupplierSettingsForm />
    </>
  )
}
