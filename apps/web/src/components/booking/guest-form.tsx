'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { guestSchema, type GuestInput } from '@/features/booking/types'

/**
 * Data tamu (FR-17).
 *
 * - Divalidasi saat BLUR, bukan setiap ketukan: galat "surel tidak sah"
 *   setelah huruf pertama mengomeli pengguna yang belum selesai mengetik.
 *   Setelah percobaan kirim pertama, validasi mengikuti perubahan — pengguna
 *   yang sedang memperbaiki galat ingin tahu kapan galatnya hilang.
 * - Galat di dekat inputnya, lewat `Field` yang sama dengan formulir masuk.
 * - Tombol kirimnya milik pemanggil (`formId`), supaya di mobile ia dapat
 *   menempel di bawah layar bersama ringkasan harga.
 */

export interface GuestFormProps {
  readonly formId: string
  readonly defaultValues?: Partial<GuestInput>
  readonly onSubmit: (values: GuestInput) => void
  readonly disabled?: boolean
}

export function GuestForm({ formId, defaultValues, onSubmit, disabled = false }: GuestFormProps) {
  const form = useForm<GuestInput>({
    resolver: zodResolver(guestSchema),
    mode: 'onBlur',
    reValidateMode: 'onChange',
    defaultValues: { fullName: '', email: '', ...defaultValues },
  })

  return (
    <form
      id={formId}
      className="flex flex-col gap-5"
      onSubmit={form.handleSubmit(onSubmit)}
      noValidate
      aria-labelledby={`${formId}-title`}
    >
      <div className="flex flex-col gap-1">
        <h2 id={`${formId}-title`} className="text-h3 font-medium">
          Data tamu
        </h2>
        <p className="text-small text-muted-foreground">
          Nama sesuai kartu identitas yang ditunjukkan saat check-in. Voucher dikirim ke surel ini.
        </p>
      </div>

      <fieldset disabled={disabled} className="flex flex-col gap-5">
        <Field
          id="guest-full-name"
          label="Nama lengkap"
          error={form.formState.errors.fullName?.message}
          control={(props) => (
            <Input {...props} autoComplete="name" {...form.register('fullName')} />
          )}
        />
        <Field
          id="guest-email"
          label="Surel"
          error={form.formState.errors.email?.message}
          control={(props) => (
            <Input
              {...props}
              type="email"
              inputMode="email"
              autoComplete="email"
              {...form.register('email')}
            />
          )}
        />
      </fieldset>
    </form>
  )
}
