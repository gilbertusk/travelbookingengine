import { SearchX } from 'lucide-react'
import Link from 'next/link'
import type { Metadata } from 'next'
import { EmptyState } from '@/components/state/states'
import { Button } from '@/components/ui/button'

export const metadata: Metadata = { title: 'Hasil pencarian' }

/**
 * Halaman hasil pencarian.
 *
 * Penampung sementara. Pengambilan dan penggabungan hasil dari lima penyedia
 * dikerjakan pada Step 13–14; yang ada sekarang hanya jalur navigasinya,
 * supaya batang pencarian di beranda tidak berakhir pada halaman 404.
 */
export default function SearchPage() {
  return (
    <div className="mx-auto max-w-content px-4 py-12 sm:px-6">
      <EmptyState
        icon={<SearchX />}
        title="Pencarian belum tersambung"
        description="Layanan pencarian dikerjakan pada tahap berikutnya. Beranda, formulir, dan alur navigasinya sudah berfungsi."
        action={
          <Button asChild variant="secondary">
            <Link href="/">Kembali ke beranda</Link>
          </Button>
        }
      />
    </div>
  )
}
