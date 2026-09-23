'use client'

import { AlertTriangle } from 'lucide-react'
import { useEffect } from 'react'
import { ErrorState } from '@/components/state/states'
import { Button } from '@/components/ui/button'

/**
 * Halaman galat.
 *
 * Dirancang, bukan bawaan Next.js. Halaman galat adalah tampilan yang paling
 * jarang dilihat dan paling banyak menentukan kesan — pengguna yang melihatnya
 * sedang dalam keadaan sudah gagal sekali.
 *
 * `digest` ditampilkan karena itulah satu-satunya yang menghubungkan apa yang
 * dilihat pengguna dengan baris log di server. Tanpa itu, laporan yang masuk
 * hanya berbunyi "halamannya error".
 */
export default function ErrorPage({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string }
  readonly reset: () => void
}) {
  useEffect(() => {
    // Pengiriman ke pengumpul galat menyusul pada Step 27; sampai saat itu,
    // menelan galat diam-diam lebih buruk daripada tidak punya pengumpul.
    // eslint-disable-next-line no-console
    console.error(error)
  }, [error])

  return (
    <div className="mx-auto max-w-detail px-4 py-16 sm:px-6">
      <ErrorState
        icon={<AlertTriangle />}
        title="Ada yang tidak berjalan semestinya"
        description="Kami tidak dapat menampilkan halaman ini. Coba muat ulang — kalau masih gagal, kemungkinan besar masalahnya di sisi kami."
        action={
          <div className="flex flex-col items-center gap-3">
            <Button variant="primary" onClick={reset}>
              Coba lagi
            </Button>
            {error.digest !== undefined && (
              <p className="text-caption text-muted-foreground">
                Kode kejadian: <span data-numeric>{error.digest}</span>
              </p>
            )}
          </div>
        }
      />
    </div>
  )
}
