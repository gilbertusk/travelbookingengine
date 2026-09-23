import type { Metadata } from 'next'
import { AuthShell } from '@/components/auth/auth-shell'
import { RegisterForm } from '@/components/auth/register-form'

export const metadata: Metadata = { title: 'Daftar' }

export default function RegisterPage() {
  return (
    <AuthShell
      title="Buat akun"
      description="Satu akun untuk mencari, memesan, dan menyimpan riwayat perjalanan."
      footer={{ question: 'Sudah punya akun?', href: '/masuk', label: 'Masuk' }}
    >
      <RegisterForm />
    </AuthShell>
  )
}
