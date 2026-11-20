import type { ReactNode } from 'react'
import { OpsNav } from '@/components/OpsNav'

export default function PanelLayout({ children }: { readonly children: ReactNode }) {
  return (
    <>
      <OpsNav />
      <main className="mx-auto flex max-w-content flex-col gap-6 p-4">{children}</main>
    </>
  )
}
