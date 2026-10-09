import { Badge, type BadgeProps } from '@/components/ui/badge'
import type { StatusLabel, StatusTone } from '@/features/bookings/presentation'

/**
 * Status sebagai lencana berteks. Warnanya hanya mengulang arti kata-katanya;
 * tanpa warna, kalimatnya tetap lengkap.
 */
const TONE_VARIANT: Readonly<Record<StatusTone, NonNullable<BadgeProps['variant']>>> = {
  success: 'success',
  waiting: 'neutral',
  refund: 'outline',
  review: 'warning',
  ended: 'neutral',
}

export function StatusBadge({ status }: { readonly status: StatusLabel }) {
  return <Badge variant={TONE_VARIANT[status.tone]}>{status.label}</Badge>
}
