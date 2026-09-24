import { Suspense } from 'react'
import type { Metadata } from 'next'
import { PropertyDetail } from '@/components/property/property-detail'

/**
 * Halaman properti.
 *
 * Slug-nya permanen — lihat search-service/src/domain/slug.ts. Itulah yang
 * membuat URL ini dapat diindeks mesin pencari dan tetap hidup meski nama
 * hotelnya berubah, sesuai PRD Bab 12.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params

  // Nama properti belum tersedia di sisi server tanpa memanggil pencarian,
  // dan pencarian membutuhkan tanggal. Judul sementara diturunkan dari slug;
  // Step 29 menggantinya dengan pemanggilan katalog yang tidak bertanggal.
  return { title: titleFromSlug(slug) }
}

function titleFromSlug(slug: string): string {
  return slug
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

export default async function PropertyPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params

  return (
    <Suspense fallback={null}>
      <PropertyDetail slug={slug} />
    </Suspense>
  )
}
