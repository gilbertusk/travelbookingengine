import type { ReactNode } from 'react'
import { Label } from '@/components/ui/label'

/**
 * Satu bidang formulir: label, kendali, dan pesan galat.
 *
 * Ketiganya disatukan supaya tidak ada bidang yang kehilangan salah satunya.
 *
 * Kendalinya dirender lewat fungsi, bukan diterima sebagai `children` biasa,
 * karena atribut `aria-describedby` dan `aria-invalid` harus menempel pada
 * elemen input itu sendiri. Kalau Field hanya membungkus, atribut itu akan
 * ditulis ulang di setiap pemanggilan — dan yang terlupa tidak menghasilkan
 * galat apa pun, hanya bidang yang pesan galatnya tidak pernah dibacakan.
 */
export interface FieldControlProps {
  readonly id: string
  readonly 'aria-describedby': string | undefined
  readonly 'aria-invalid': boolean
}

export function Field({
  id,
  label,
  error,
  hint,
  control,
}: {
  readonly id: string
  readonly label: string
  readonly error?: string | undefined
  readonly hint?: string | undefined
  readonly control: (props: FieldControlProps) => ReactNode
}) {
  const hintId = hint === undefined ? undefined : `${id}-hint`
  const errorId = `${id}-error`
  const describedBy = [hintId, error === undefined ? undefined : errorId]
    .filter((value) => value !== undefined)
    .join(' ')

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>

      {control({
        id,
        'aria-describedby': describedBy.length === 0 ? undefined : describedBy,
        'aria-invalid': error !== undefined,
      })}

      {hint !== undefined && (
        <p id={hintId} className="text-caption text-muted-foreground">
          {hint}
        </p>
      )}

      {/* Wilayah galat selalu ada di DOM meski kosong: wilayah aria-live yang
          baru muncul bersamaan dengan isinya sering tidak ikut diumumkan. */}
      <p id={errorId} aria-live="polite" className="text-caption text-destructive empty:hidden">
        {error}
      </p>
    </div>
  )
}
