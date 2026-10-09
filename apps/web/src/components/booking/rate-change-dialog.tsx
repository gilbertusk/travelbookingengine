'use client'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { formatRupiah } from '@/features/search/criteria'
import type { Money } from '@/features/booking/types'

/**
 * Harga berubah (FR-14, US-02) — momen yang paling menentukan kepercayaan.
 *
 * Glosarium PRD menyebut Rate Change kondisi NORMAL, bukan kesalahan, dan
 * dialog ini dirancang mengikutinya:
 *
 * - Tidak ada merah, tidak ada ikon peringatan, tidak ada kata "gagal". Harga
 *   hotel memang bergerak; yang salah adalah menyembunyikannya.
 * - Harga lama, harga baru, dan SELISIHNYA ditulis eksplisit. Pengguna tidak
 *   perlu menghitung sendiri berapa yang berubah.
 * - Aksi utama "Terima harga baru"; aksi sekunder kembali ke hasil pencarian.
 *   Tidak ada pilihan "lanjutkan dengan harga lama" — harga lama sudah tidak
 *   ditawarkan siapa pun, dan pura-pura menawarkannya adalah kebohongan.
 *
 * Radix mengunci fokus dan menutup dengan Escape. Menutup BUKAN menolak:
 * pemesanan tetap menunggu persetujuan, dan halaman menyediakan jalan untuk
 * membuka dialog ini lagi.
 */

export interface RateChangeDialogProps {
  readonly open: boolean
  readonly previous: Money
  readonly current: Money
  /** `null` bila mata uangnya berbeda — selisihnya tidak bermakna. */
  readonly difference: Money | null
  readonly accepting: boolean
  readonly onAccept: () => void
  readonly onBack: () => void
  readonly onOpenChange: (open: boolean) => void
}

export function RateChangeDialog({
  open,
  previous,
  current,
  difference,
  accepting,
  onAccept,
  onBack,
  onOpenChange,
}: RateChangeDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Harga kamar ini baru saja diperbarui</DialogTitle>
          <DialogDescription>
            Penyedia memperbarui tarifnya sejak kamu melihatnya. Ini wajar terjadi — kami
            menunjukkannya sebelum kamu membayar, bukan sesudahnya.
          </DialogDescription>
        </DialogHeader>

        <dl className="mt-6 flex flex-col gap-3 text-body">
          <Row term="Harga sebelumnya">
            <span className="tabular-nums text-muted-foreground line-through">
              {formatMoney(previous)}
            </span>
          </Row>
          <Row term="Harga sekarang">
            <span className="text-h3 font-semibold tabular-nums">{formatMoney(current)}</span>
          </Row>
          {difference === null ? null : (
            <Row term="Selisih">
              <span className="tabular-nums">{differenceLabel(difference)}</span>
            </Row>
          )}
        </dl>

        <DialogFooter>
          <Button variant="secondary" onClick={onBack} disabled={accepting}>
            Kembali ke hasil pencarian
          </Button>
          <Button variant="primary" onClick={onAccept} disabled={accepting}>
            {accepting ? 'Memeriksa harga…' : 'Terima harga baru'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Row({ term, children }: { readonly term: string; readonly children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border pb-3 last:border-b-0">
      <dt className="text-small text-muted-foreground">{term}</dt>
      <dd>{children}</dd>
    </div>
  )
}

/** "naik Rp 158.000" / "turun Rp 40.000" — arah ditulis, bukan hanya tanda minus. */
export function differenceLabel(difference: Money): string {
  if (difference.amountMinor === 0) return 'tidak berubah'
  const direction = difference.amountMinor > 0 ? 'naik' : 'turun'

  return `${direction} ${formatMoney({ ...difference, amountMinor: Math.abs(difference.amountMinor) })}`
}

export function formatMoney(money: Money): string {
  if (money.currency === 'IDR') return formatRupiah(money.amountMinor)

  return new Intl.NumberFormat('en-US', { style: 'currency', currency: money.currency }).format(
    money.amountMinor / 100,
  )
}
