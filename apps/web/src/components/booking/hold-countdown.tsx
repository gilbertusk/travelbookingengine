'use client'

import { Clock } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { announcement, countdown, crossedThreshold } from '@/features/booking/countdown'
import { cn } from '@/lib/cn'

/**
 * Hitung mundur hold (FR-15) — DESIGN-SYSTEM.md bagian 6.
 *
 * - Disinkronkan dengan jam booking-service lewat `offsetMs`, bukan jam lokal.
 * - Netral di atas lima menit, nada peringatan di bawahnya. Warna tidak
 *   berdiri sendiri: kalimatnya ikut berubah.
 * - **Tidak berkedip.** Angka berganti setiap detik tanpa animasi apa pun;
 *   kedipan menarik perhatian dari satu-satunya hal yang perlu dilakukan
 *   pengguna, yaitu menyelesaikan pembayaran.
 * - Pembaca layar diberi tahu HANYA di ambang tertentu, lewat wilayah
 *   `aria-live` terpisah. Angka yang berdetak tidak diumumkan.
 */

export interface HoldCountdownProps {
  readonly heldUntil: string
  /** Selisih jam booking-service dan jam lokal. Lihat clockOffset. */
  readonly offsetMs: number
  readonly onExpire: () => void
  /** Untuk uji. */
  readonly now?: () => number
}

const TICK_MS = 1_000

export function HoldCountdown({
  heldUntil,
  offsetMs,
  onExpire,
  now = Date.now,
}: HoldCountdownProps) {
  const [state, setState] = useState(() => countdown(heldUntil, now(), offsetMs))
  const [spoken, setSpoken] = useState('')
  const previous = useRef(state.remainingMs)
  const expired = useRef(false)
  const onExpireRef = useRef(onExpire)

  useEffect(() => {
    onExpireRef.current = onExpire
  }, [onExpire])

  useEffect(() => {
    function tick(): void {
      const next = countdown(heldUntil, now(), offsetMs)
      const crossed = crossedThreshold(previous.current, next.remainingMs)
      previous.current = next.remainingMs
      setState(next)
      if (crossed !== undefined) setSpoken(announcement(crossed))
      if (next.tone === 'expired' && !expired.current) {
        expired.current = true
        onExpireRef.current()
      }
    }

    tick()
    const timer = setInterval(tick, TICK_MS)
    return () => {
      clearInterval(timer)
    }
  }, [heldUntil, offsetMs, now])

  const warning = state.tone !== 'neutral'

  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-lg border px-4 py-3',
        warning ? 'border-warning bg-warning/10' : 'border-border bg-muted/60',
      )}
    >
      <Clock
        aria-hidden="true"
        className={cn('size-5 shrink-0', warning ? 'text-foreground' : 'text-muted-foreground')}
      />
      <p className="text-small text-foreground">
        {warning ? 'Segera selesaikan pembayaran. Kamar ditahan' : 'Kamar ditahan untukmu'} selama{' '}
        {/* Berganti setiap detik, tetapi bukan wilayah aria-live: dibacakan
            hanya bila pengguna menelusurinya. */}
        <span className="font-semibold tabular-nums">{state.clock}</span>
      </p>
      <p role="status" aria-live="polite" className="sr-only">
        {spoken}
      </p>
    </div>
  )
}
