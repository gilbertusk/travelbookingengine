'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MIN_PASSWORD_LENGTH, registerSchema, type RegisterInput } from '@/features/auth/types'
import { useRegister } from '@/features/auth/use-auth'
import { humanMessage } from '@/lib/api-error'
import { Field } from './field'

export function RegisterForm() {
  const router = useRouter()
  const registerMutation = useRegister()

  const form = useForm<RegisterInput>({
    resolver: zodResolver(registerSchema),
    // Validasi berjalan saat bidang ditinggalkan, bukan pada setiap ketukan.
    // Memberi tahu "kata sandi terlalu pendek" pada karakter pertama adalah
    // gangguan, bukan bantuan.
    mode: 'onBlur',
    defaultValues: { name: '', email: '', password: '' },
  })

  function onSubmit(values: RegisterInput): void {
    registerMutation.mutate(values, {
      onSuccess: () => {
        router.push('/')
      },
    })
  }

  return (
    <form className="flex flex-col gap-5" onSubmit={form.handleSubmit(onSubmit)} noValidate>
      {registerMutation.isError && (
        <Alert variant="destructive">
          <AlertDescription>{humanMessage(registerMutation.error)}</AlertDescription>
        </Alert>
      )}

      <Field
        id="name"
        label="Nama"
        error={form.formState.errors.name?.message}
        control={(props) => <Input {...props} autoComplete="name" {...form.register('name')} />}
      />

      <Field
        id="email"
        label="Surel"
        error={form.formState.errors.email?.message}
        control={(props) => (
          <Input {...props} type="email" autoComplete="email" {...form.register('email')} />
        )}
      />

      <Field
        id="password"
        label="Kata sandi"
        hint={`Minimal ${String(MIN_PASSWORD_LENGTH)} karakter.`}
        error={form.formState.errors.password?.message}
        control={(props) => (
          <Input
            {...props}
            type="password"
            autoComplete="new-password"
            {...form.register('password')}
          />
        )}
      />

      <Button type="submit" variant="primary" disabled={registerMutation.isPending}>
        {registerMutation.isPending ? 'Membuat akun…' : 'Buat akun'}
      </Button>
    </form>
  )
}
