import type { Metadata } from 'next'
import { LoginForm } from '@/features/auth/LoginForm'

export const metadata: Metadata = { title: 'Masuk' }

export default function Page() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 p-4">
      <h1 className="text-h2">Panel operator</h1>
      <LoginForm />
    </main>
  )
}
