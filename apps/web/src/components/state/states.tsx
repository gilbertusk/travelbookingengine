import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * Empat keadaan wajib.
 *
 * DESIGN-SYSTEM.md bagian 7: setiap tampilan yang mengambil data punya
 * keadaan memuat, kosong, galat, dan berisi. Tanpa pengecualian.
 *
 * Alasan komponennya dibuat generik sejak awal, bukan setelah ada lima
 * halaman: keadaan yang tidak punya komponen siap pakai adalah keadaan yang
 * akan dilewati saat dikejar tenggat, dan yang tersisa adalah halaman yang
 * kosong tanpa penjelasan ketika sesuatu gagal.
 */

export function LoadingState({
  label = 'Memuat',
  children,
  className,
}: {
  /** Diumumkan pembaca layar; tidak terlihat di layar. */
  readonly label?: string
  /** Skeleton yang menyerupai bentuk akhir konten. */
  readonly children: ReactNode
  readonly className?: string
}) {
  return (
    // aria-busy memberi tahu teknologi bantu bahwa isi wilayah ini sedang
    // berubah, sehingga pembaca layar tidak membacakan skeleton sebagai
    // konten sungguhan.
    <div aria-busy="true" aria-live="polite" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  )
}

function Placeholder({
  icon,
  title,
  description,
  action,
  tone,
}: {
  readonly icon: ReactNode
  readonly title: string
  readonly description: string
  readonly action?: ReactNode
  readonly tone: 'neutral' | 'destructive'
}) {
  return (
    <div className="flex flex-col items-center gap-4 px-6 py-16 text-center">
      <div
        aria-hidden="true"
        className={cn(
          'flex size-12 items-center justify-center rounded-full',
          tone === 'destructive'
            ? 'bg-destructive/10 text-destructive'
            : 'bg-muted text-muted-foreground',
          '[&_svg]:size-5',
        )}
      >
        {icon}
      </div>

      <div className="flex max-w-prose flex-col gap-2">
        <p className="text-h3 font-medium">{title}</p>
        <p className="text-small text-muted-foreground">{description}</p>
      </div>

      {action}
    </div>
  )
}

export function EmptyState(props: {
  readonly icon: ReactNode
  readonly title: string
  readonly description: string
  /** Satu aksi lanjutan. Keadaan kosong tanpa jalan keluar adalah jalan buntu. */
  readonly action?: ReactNode
}) {
  return <Placeholder {...props} tone="neutral" />
}

export function ErrorState(props: {
  readonly icon: ReactNode
  readonly title: string
  /** Penjelasan dalam bahasa manusia, bukan pantulan pesan server. */
  readonly description: string
  /** Cara mencoba lagi. Wajib ada. */
  readonly action?: ReactNode
}) {
  return (
    <div role="alert">
      <Placeholder {...props} tone="destructive" />
    </div>
  )
}
