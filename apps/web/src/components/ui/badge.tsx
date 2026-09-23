import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/cn'

/**
 * Badge.
 *
 * Varian semantik memakai latar yang sangat diredam, bukan warna penuh.
 * Badge berwarna penuh bersaing dengan tombol aksi utama, dan pada halaman
 * hasil pencarian yang penuh label, hasilnya menjadi bising.
 *
 * Warna tidak pernah menjadi satu-satunya pembawa informasi: badge selalu
 * berisi teks.
 *
 * Latarnya 8%, bukan 10% atau 12%. Selisihnya tidak terlihat mata, tetapi
 * pada 10% teks aksen di atas latar terang turun ke 4.43:1 — di bawah AA.
 * Dijaga scripts/verify-contrast.mjs.
 */
const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full px-2 py-1 text-caption font-medium',
  {
    variants: {
      variant: {
        neutral: 'bg-muted text-muted-foreground',
        outline: 'border border-border text-muted-foreground',
        primary: 'bg-primary/8 text-primary',
        success: 'bg-success/8 text-success',
        // Teks netral, bukan kuning. Kuning yang cukup terang untuk terbaca
        // di tampilan gelap menjadi cokelat di tampilan terang, dan
        // `warning-foreground` — yang gelap — tidak terbaca di atas latar
        // gelap. Teks utama lulus AA di kedua tema; artinya tetap terbawa
        // oleh latar kuning dan oleh kata-katanya sendiri.
        warning: 'bg-warning/15 text-foreground',
        destructive: 'bg-destructive/8 text-destructive',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
)

export type BadgeProps = ComponentProps<'span'> & VariantProps<typeof badgeVariants>

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { badgeVariants }
