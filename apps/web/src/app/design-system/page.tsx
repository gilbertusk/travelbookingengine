import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import {
  BadgeShowcase,
  ButtonShowcase,
  FeedbackShowcase,
  FormShowcase,
  OverlayShowcase,
  StatesShowcase,
  StructureShowcase,
} from '@/components/design-system/primitives-showcase'
import {
  ColorSwatches,
  RadiusAndElevation,
  SpacingScale,
} from '@/components/design-system/swatches'

export const metadata: Metadata = {
  title: 'Sistem desain',
  description: 'Token, skala tipografi, dan seluruh primitif antarmuka.',
}

/**
 * Halaman acuan sistem desain.
 *
 * Gunanya dua. Sebagai alat kerja: setiap primitif terlihat berdampingan,
 * sehingga token yang salah di salah satu tema ketahuan di satu layar, bukan
 * setelah tersebar. Dan sebagai bukti: sistem desain yang hanya ada di dokumen
 * tidak dapat dibedakan dari sistem desain yang tidak pernah diterapkan.
 *
 * Coba dengan pengalih tema di header — seluruh isi halaman ini berubah lewat
 * redefinisi token, tanpa satu pun kelas `dark:` berisi warna di komponen.
 */

const TYPE_SCALE = [
  {
    token: 'display',
    className: 'font-display text-display',
    note: '56px · judul hero, satu per halaman',
  },
  { token: 'h1', className: 'font-display text-h1', note: '30px · judul halaman' },
  { token: 'h2', className: 'font-display text-h2', note: '24px · judul bagian' },
  { token: 'h3', className: 'text-h3 font-medium', note: '18px · judul kartu (Inter)' },
  { token: 'body', className: 'text-body', note: '15px · teks utama' },
  { token: 'small', className: 'text-small', note: '13px · metadata, label' },
  { token: 'caption', className: 'text-caption', note: '12px · keterangan, syarat' },
] as const

function Section({
  title,
  description,
  children,
}: {
  readonly title: string
  readonly description?: string
  readonly children: ReactNode
}) {
  return (
    <section className="border-t border-border pt-10">
      <h2 className="font-display text-h2">{title}</h2>
      {description !== undefined && (
        <p className="mt-2 max-w-prose text-small text-muted-foreground">{description}</p>
      )}
      <div className="mt-8">{children}</div>
    </section>
  )
}

export default function DesignSystemPage() {
  return (
    <div className="mx-auto flex max-w-content flex-col gap-16 px-4 py-12 sm:px-6">
      <header>
        <p className="text-small font-medium uppercase tracking-wide text-muted-foreground">
          Acuan internal
        </p>
        <h1 className="mt-4 font-display text-h1">Sistem desain</h1>
        <p className="mt-3 max-w-prose text-body text-muted-foreground">
          Seluruh token dan primitif yang boleh dipakai. Kalau sesuatu tidak ada di halaman ini, ia
          belum menjadi bagian dari sistem.
        </p>
      </header>

      <Section
        title="Warna"
        description="Aksen hanya untuk satu aksi utama per layar. Merah untuk yang merusak atau gagal, kuning untuk peringatan nyata — keduanya bukan untuk dekorasi."
      >
        <ColorSwatches />
      </Section>

      <Section
        title="Tipografi"
        description="Dua typeface. Instrument Serif hanya untuk judul; seluruh teks antarmuka memakai Inter."
      >
        <ul className="flex flex-col gap-6">
          {TYPE_SCALE.map((entry) => (
            <li key={entry.token} className="flex flex-col gap-1">
              <span className={entry.className}>Menginap tanpa menebak harga</span>
              <span className="text-caption text-muted-foreground">
                <code>{entry.token}</code> — {entry.note}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Jarak" description="Skala 4px. Tidak ada nilai di luar skala.">
        <SpacingScale />
      </Section>

      <Section
        title="Radius dan elevasi"
        description="Satu tingkat bayangan, dan hanya untuk elemen yang benar-benar melayang."
      >
        <RadiusAndElevation />
      </Section>

      <Section title="Tombol" description="Empat varian, dan daftarnya tertutup.">
        <ButtonShowcase />
      </Section>

      <Section title="Badge">
        <BadgeShowcase />
      </Section>

      <Section title="Formulir" description="Setiap bidang punya label sungguhan.">
        <FormShowcase />
      </Section>

      <Section
        title="Lapisan melayang"
        description="Dialog dan sheet mengunci fokus, mengembalikannya ke pemicu saat ditutup, dan dapat ditutup dengan Escape."
      >
        <OverlayShowcase />
      </Section>

      <Section title="Pemberitahuan">
        <FeedbackShowcase />
      </Section>

      <Section title="Struktur" description="Kartu tidak pernah disarangkan.">
        <StructureShowcase />
      </Section>

      <Section
        title="Empat keadaan"
        description="Setiap tampilan yang mengambil data wajib punya keempatnya. Keadaan kelima — parsial — dibuat bersama halaman pencarian."
      >
        <StatesShowcase />
      </Section>
    </div>
  )
}
