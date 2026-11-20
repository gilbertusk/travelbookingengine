import { Badge } from '@tbe/ui/badge'
import type { CIRCUIT_STATES } from './schema'

/**
 * Keadaan pemutus. Kata DAN warna — warna saja tidak terbaca pembaca layar
 * maupun orang dengan buta warna (DESIGN-SYSTEM.md bagian 9).
 */
const LOOK = {
  closed: { label: 'tertutup', variant: 'success' },
  half_open: { label: 'setengah', variant: 'warning' },
  open: { label: 'TERBUKA', variant: 'destructive' },
} as const

export function CircuitBadge({ state }: { readonly state: (typeof CIRCUIT_STATES)[number] }) {
  const look = LOOK[state]
  return <Badge variant={look.variant}>{look.label}</Badge>
}
