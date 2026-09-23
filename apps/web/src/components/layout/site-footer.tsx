import { publicConfig } from '@/config'

/**
 * Footer.
 *
 * Ringkas dengan sengaja. Footer bertingkat berisi lima kolom tautan adalah
 * ciri halaman pemasaran, dan ini bukan halaman pemasaran.
 */
export function SiteFooter() {
  return (
    <footer className="mt-24 border-t border-border">
      <div className="mx-auto flex max-w-content flex-col gap-2 px-4 py-8 text-small text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p>
          <span className="font-display text-body text-foreground">{publicConfig.appName}</span> —
          mesin pemesanan perjalanan.
        </p>
        <p className="text-caption">
          Proyek portofolio. Data properti dan harga berasal dari penyedia tiruan.
        </p>
      </div>
    </footer>
  )
}
