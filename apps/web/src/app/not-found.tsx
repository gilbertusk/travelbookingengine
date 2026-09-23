import { Compass } from 'lucide-react'
import Link from 'next/link'
import { EmptyState } from '@/components/state/states'
import { Button } from '@/components/ui/button'

export default function NotFoundPage() {
  return (
    <div className="mx-auto max-w-detail px-4 py-16 sm:px-6">
      <EmptyState
        icon={<Compass />}
        title="Halaman ini tidak ada"
        description="Alamatnya mungkin salah ketik, atau halamannya sudah dipindahkan. Mulai lagi dari pencarian."
        action={
          <Button asChild variant="primary">
            <Link href="/">Kembali ke pencarian</Link>
          </Button>
        }
      />
    </div>
  )
}
