import { Luggage } from 'lucide-react'
import Link from 'next/link'
import type { Metadata } from 'next'
import { EmptyState } from '@/components/state/states'
import { Button } from '@/components/ui/button'

export const metadata: Metadata = { title: 'Pemesananku' }

/**
 * Daftar pemesanan.
 *
 * Rute privat: middleware mengalihkan pengunjung tanpa sesi ke halaman masuk
 * sebelum halaman ini sempat dirender. Isinya menyusul pada Step 26.
 */
export default function BookingsPage() {
  return (
    <div className="mx-auto max-w-detail px-4 py-12 sm:px-6">
      <h1 className="font-display text-h1">Pemesananku</h1>

      <div className="mt-8 border-t border-border">
        <EmptyState
          icon={<Luggage />}
          title="Belum ada pemesanan"
          description="Pemesanan yang kamu buat akan muncul di sini, lengkap dengan status dan kebijakan pembatalannya."
          action={
            <Button asChild variant="primary">
              <Link href="/">Cari penginapan</Link>
            </Button>
          }
        />
      </div>
    </div>
  )
}
