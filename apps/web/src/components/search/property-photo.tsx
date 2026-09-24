import Image from 'next/image'
import { Building2 } from 'lucide-react'
import { cn } from '@/lib/cn'

/**
 * Foto properti, rasio 4:3.
 *
 * Rasionya ditetapkan lewat `aspect-[4/3]` dan gambarnya mengisi kotak itu —
 * bukan sebaliknya. Itu yang membuat tidak ada pergeseran tata letak: ruang
 * kartu sudah terbentuk penuh sebelum satu piksel gambar pun sampai, jadi
 * kartu di bawahnya tidak pernah terdorong.
 *
 * Katalog belum menyimpan foto — Step 12b sengaja tidak mengisinya, karena
 * foto adalah data statis yang sumbernya belum diputuskan. Sampai ada, yang
 * ditampilkan adalah penampung bertoken yang WARNANYA DITURUNKAN dari
 * pengenal properti. Turunan itu bukan hiasan: penampung yang seragam membuat
 * dua puluh kartu terlihat seperti daftar yang belum dimuat, sedangkan yang
 * berbeda-beda terbaca sebagai dua puluh hotel yang berbeda.
 */

export interface PropertyPhotoProps {
  readonly name: string
  /** Pengenal properti. Menentukan warna penampung secara tetap. */
  readonly seed: string
  readonly src?: string | undefined
  readonly priority?: boolean
  readonly className?: string
  readonly sizes?: string
}

export function PropertyPhoto({
  name,
  seed,
  src,
  priority = false,
  className,
  sizes = '(min-width: 640px) 13rem, 100vw',
}: PropertyPhotoProps) {
  return (
    <div
      className={cn('relative aspect-[4/3] w-full overflow-hidden rounded-lg bg-muted', className)}
    >
      {src === undefined ? (
        <Placeholder seed={seed} />
      ) : (
        <Image
          src={src}
          alt={`Foto ${name}`}
          fill
          sizes={sizes}
          priority={priority}
          className="object-cover"
          // Placeholder blur sebaris: satu piksel abu-abu yang diregangkan.
          // Tidak menambah satu pun permintaan jaringan, dan sudah cukup
          // untuk menghindari kedipan putih saat gambar besar dimuat.
          placeholder="blur"
          blurDataURL={BLUR}
        />
      )}
    </div>
  )
}

const BLUR = 'data:image/gif;base64,R0lGODlhAQABAIAAAMLCwgAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw=='

/**
 * Penampung bertoken.
 *
 * Kedua warnanya dirujuk lewat variabel token, bukan nilai mentah — jadi ia
 * ikut berubah di tampilan gelap tanpa satu pun kelas `dark:`. Yang
 * diturunkan dari pengenal hanyalah SUDUT gradiennya, dan sudut tidak punya
 * kontras yang perlu diperiksa.
 */
function Placeholder({ seed }: { readonly seed: string }) {
  return (
    <div
      aria-hidden="true"
      className="flex size-full items-center justify-center text-muted-foreground"
      style={{
        backgroundImage: `linear-gradient(${String(angleOf(seed))}deg, var(--color-muted), var(--color-border))`,
      }}
    >
      <Building2 className="size-8 opacity-40" />
    </div>
  )
}

function angleOf(seed: string): number {
  let hash = 0
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 360
  }

  return hash
}
