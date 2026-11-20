'use client'

import { Alert, AlertDescription } from '@tbe/ui/alert'
import { Button } from '@tbe/ui/button'
import { Input } from '@tbe/ui/input'
import { useState, type SyntheticEvent } from 'react'

/**
 * Masuk sebagai operator. Akun pelanggan ditolak rute server dengan pesan
 * yang jelas (lihat login.ts); token tidak pernah sampai ke halaman ini.
 */
export function LoginForm({ onSignedIn }: { readonly onSignedIn?: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const [isPending, setPending] = useState(false)

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError(undefined)
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    setPending(false)
    if (response.ok) {
      ;(
        onSignedIn ??
        (() => {
          window.location.assign('/')
        })
      )()
      return
    }
    const payload: unknown = await response.json().catch(() => null)
    setError(messageOf(payload))
  }

  return (
    <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-4" noValidate>
      <div className="flex flex-col gap-1">
        <label htmlFor="email" className="text-small">
          Surel
        </label>
        <Input
          id="email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value)
          }}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="password" className="text-small">
          Kata sandi
        </label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value)
          }}
        />
      </div>
      {error !== undefined && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Button type="submit" variant="primary" disabled={isPending}>
        Masuk
      </Button>
    </form>
  )
}

function messageOf(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null && 'error' in payload) {
    const { error } = payload
    if (
      typeof error === 'object' &&
      error !== null &&
      'message' in error &&
      typeof error.message === 'string'
    ) {
      return error.message
    }
  }
  return 'Masuk gagal.'
}
