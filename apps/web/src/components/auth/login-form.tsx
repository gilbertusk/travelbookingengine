'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { useRouter, useSearchParams } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { loginSchema, type LoginInput } from '@/features/auth/types'
import { useLogin } from '@/features/auth/use-auth'
import { humanMessage } from '@/lib/api-error'
import { safeRedirect } from '@/lib/safe-redirect'
import { Field } from './field'

export function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const loginMutation = useLogin()

  const form = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  })

  function onSubmit(values: LoginInput): void {
    loginMutation.mutate(values, {
      onSuccess: () => {
        router.push(safeRedirect(searchParams.get('lanjut')))
      },
    })
  }

  return (
    <form className="flex flex-col gap-5" onSubmit={form.handleSubmit(onSubmit)} noValidate>
      {loginMutation.isError && (
        <Alert variant="destructive">
          <AlertDescription>{humanMessage(loginMutation.error)}</AlertDescription>
        </Alert>
      )}

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
        error={form.formState.errors.password?.message}
        control={(props) => (
          <Input
            {...props}
            type="password"
            autoComplete="current-password"
            {...form.register('password')}
          />
        )}
      />

      <Button type="submit" variant="primary" disabled={loginMutation.isPending}>
        {loginMutation.isPending ? 'Memeriksa…' : 'Masuk'}
      </Button>
    </form>
  )
}
