import { Check, Circle, Minus } from 'lucide-react'
import type { Stage, StageState } from '@/features/booking/timeline'
import { cn } from '@/lib/cn'

/**
 * Tahapan pemesanan secara vertikal, dengan keadaan sekarang ditandai
 * (DESIGN-SYSTEM.md bagian 6).
 *
 * Tahap yang sedang berjalan TIDAK berputar atau berdenyut — animasi berulang
 * tanpa henti dilarang bagian 8, dan pengguna yang menunggu uangnya tidak
 * perlu dibuat gelisah oleh lingkaran yang berputar. Penandanya titik penuh
 * dan teks tebal; warnanya tidak pernah satu-satunya pembawa arti, karena
 * setiap tahap juga punya label keadaan untuk pembaca layar.
 */
export function BookingStatusTimeline({ stages }: { readonly stages: readonly Stage[] }) {
  return (
    <ol className="flex flex-col" aria-label="Tahapan pemesanan">
      {stages.map((stage, index) => (
        <li
          key={stage.key}
          aria-current={stage.state === 'current' ? 'step' : undefined}
          className="relative flex gap-4 pb-6 last:pb-0"
        >
          {index < stages.length - 1 ? (
            <span
              aria-hidden="true"
              className={cn(
                'absolute left-3 top-7 h-[calc(100%-1.75rem)] w-px -translate-x-1/2',
                stage.state === 'done' ? 'bg-success' : 'bg-border',
              )}
            />
          ) : null}
          <Marker state={stage.state} />
          <div className="flex min-w-0 flex-col gap-1">
            <p
              className={cn(
                'text-body',
                stage.state === 'current' ? 'font-medium text-foreground' : undefined,
                stage.state === 'pending' || stage.state === 'stopped'
                  ? 'text-muted-foreground'
                  : undefined,
              )}
            >
              {stage.label}
              <span className="sr-only">, {STATE_LABEL[stage.state]}</span>
            </p>
            {stage.detail === undefined ? null : (
              <p className="text-small text-muted-foreground">{stage.detail}</p>
            )}
          </div>
        </li>
      ))}
    </ol>
  )
}

const STATE_LABEL: Readonly<Record<StageState, string>> = {
  done: 'selesai',
  current: 'sedang berjalan',
  pending: 'belum dimulai',
  stopped: 'tidak dilanjutkan',
}

function Marker({ state }: { readonly state: StageState }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'relative z-[1] flex size-6 shrink-0 items-center justify-center rounded-full border [&_svg]:size-3.5',
        state === 'done' && 'border-success bg-success text-success-foreground',
        // Bukan aksen: aksen milik satu aksi utama per layar (bagian 2).
        state === 'current' && 'border-foreground bg-card text-foreground',
        state === 'pending' && 'border-border bg-card text-muted-foreground',
        state === 'stopped' && 'border-border bg-muted text-muted-foreground',
      )}
    >
      {state === 'done' ? <Check /> : null}
      {state === 'current' ? <Circle className="fill-current" /> : null}
      {state === 'stopped' ? <Minus /> : null}
    </span>
  )
}
