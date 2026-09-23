import type { Metadata } from 'next'
import { Suspense } from 'react'
import { AuthShell } from '@/components/auth/auth-shell'
import { LoginForm } from '@/components/auth/login-form'
import { Skeleton } from '@/components/ui/skeleton'

export const metadata: Metadata = { title: 'Masuk' }

export default function LoginPage() {
  return (
    <AuthShell
      title="Masuk"
      description="Lanjutkan pemesanan dan lihat riwayat perjalananmu."
      footer={{ question: 'Belum punya akun?', href: '/daftar', label: 'Daftar' }}
    >
      {/* useSearchParams membaca URL di klien, jadi bagian ini tidak dapat
          dirender lebih dulu di server. Tanpa Suspense, Next menolak
          membangun halaman ini sebagai halaman statis. */}
      <Suspense fallback={<Skeleton className="h-64 w-full" />}>
        <LoginForm />
      </Suspense>
    </AuthShell>
  )
}
