/**
 * Contoh token warna, radius, dan bayangan.
 *
 * Halaman ini adalah alat kerja, bukan hiasan: begitu ada token yang tidak
 * terlihat benar di salah satu tema, kesalahannya muncul di sini sebelum
 * sempat tersebar ke sepuluh halaman.
 *
 * Nama kelas ditulis lengkap, bukan disusun dari potongan string, karena
 * Tailwind memindai kode sumber untuk mencari kelas yang dipakai — kelas yang
 * dirangkai saat berjalan tidak akan pernah ikut dibangun.
 */

const COLOR_TOKENS = [
  { name: 'background', swatch: 'bg-background', note: 'Latar halaman' },
  { name: 'foreground', swatch: 'bg-foreground', note: 'Teks utama' },
  { name: 'card', swatch: 'bg-card', note: 'Permukaan kartu' },
  { name: 'muted', swatch: 'bg-muted', note: 'Latar diredam' },
  { name: 'muted-foreground', swatch: 'bg-muted-foreground', note: 'Teks sekunder' },
  { name: 'border', swatch: 'bg-border', note: 'Garis pemisah' },
  { name: 'primary', swatch: 'bg-primary', note: 'Aksen — satu aksi utama per layar' },
  { name: 'success', swatch: 'bg-success', note: 'Berhasil, terkonfirmasi' },
  { name: 'warning', swatch: 'bg-warning', note: 'Peringatan nyata saja' },
  { name: 'destructive', swatch: 'bg-destructive', note: 'Merusak atau gagal' },
] as const

const SPACING_STEPS = [
  { label: '1 — 4px', width: 'w-1' },
  { label: '2 — 8px', width: 'w-2' },
  { label: '3 — 12px', width: 'w-3' },
  { label: '4 — 16px', width: 'w-4' },
  { label: '6 — 24px', width: 'w-6' },
  { label: '8 — 32px', width: 'w-8' },
  { label: '12 — 48px', width: 'w-12' },
  { label: '16 — 64px', width: 'w-16' },
  { label: '24 — 96px', width: 'w-24' },
] as const

const RADII = [
  { label: 'sm — 6px', className: 'rounded-sm' },
  { label: 'md — 8px', className: 'rounded-md' },
  { label: 'lg — 10px', className: 'rounded-lg' },
  { label: 'xl — 14px', className: 'rounded-xl' },
  { label: 'full', className: 'rounded-full' },
] as const

export function ColorSwatches() {
  return (
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {COLOR_TOKENS.map((token) => (
        <li key={token.name} className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className={`size-11 shrink-0 rounded-md border border-border ${token.swatch}`}
          />
          <span className="flex flex-col">
            <code className="text-small">{token.name}</code>
            <span className="text-caption text-muted-foreground">{token.note}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}

export function SpacingScale() {
  return (
    <ul className="flex flex-col gap-2">
      {SPACING_STEPS.map((step) => (
        <li key={step.label} className="flex items-center gap-4">
          <span aria-hidden="true" className={`h-4 rounded-sm bg-primary/60 ${step.width}`} />
          <span className="text-small text-muted-foreground" data-numeric>
            {step.label}
          </span>
        </li>
      ))}
    </ul>
  )
}

export function RadiusAndElevation() {
  return (
    <div className="flex flex-col gap-8">
      <ul className="flex flex-wrap gap-6">
        {RADII.map((radius) => (
          <li key={radius.label} className="flex flex-col items-center gap-2">
            <span
              aria-hidden="true"
              className={`size-16 border border-border bg-muted ${radius.className}`}
            />
            <span className="text-caption text-muted-foreground">{radius.label}</span>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-end gap-6">
        <div className="flex flex-col items-center gap-2">
          <span aria-hidden="true" className="size-24 rounded-lg border border-border bg-card" />
          <span className="text-caption text-muted-foreground">Tanpa bayangan — kartu daftar</span>
        </div>
        <div className="flex flex-col items-center gap-2">
          <span aria-hidden="true" className="size-24 rounded-lg bg-card shadow-float" />
          <span className="text-caption text-muted-foreground">shadow-float — melayang</span>
        </div>
      </div>
    </div>
  )
}
