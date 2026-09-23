import { Building2, Clock, ShieldCheck } from 'lucide-react'
import { SearchBar } from '@/components/search/search-bar'

/**
 * Beranda.
 *
 * Satu hero dan satu bagian pendukung. Bukan halaman pemasaran — pengguna
 * datang untuk mencari penginapan, dan setiap bagian tambahan hanya menjauhkan
 * batang pencarian dari layar pertama.
 */

const SUPPORTING = [
  {
    icon: Building2,
    title: 'Lima penyedia sekaligus',
    body: 'Satu pencarian menembak beberapa penyedia, lalu hasilnya disatukan dan dibandingkan dalam satu daftar.',
  },
  {
    icon: Clock,
    title: 'Harga dikunci sebelum bayar',
    body: 'Tarif ditahan selama proses pemesanan. Kalau penyedia mengubahnya, kamu diberi tahu sebelum membayar.',
  },
  {
    icon: ShieldCheck,
    title: 'Biaya terlihat sejak awal',
    body: 'Pajak dan biaya layanan ditampilkan pada harga yang kamu lihat, bukan muncul di langkah terakhir.',
  },
] as const

export default function HomePage() {
  return (
    <>
      <section className="mx-auto max-w-content px-4 pb-16 pt-12 sm:px-6 sm:pb-24 sm:pt-20">
        <div className="max-w-prose">
          <p className="text-small font-medium uppercase tracking-wide text-muted-foreground">
            Mesin pemesanan perjalanan
          </p>
          <h1 className="mt-4 font-display text-display">Menginap tanpa menebak-nebak harga.</h1>
          <p className="mt-5 text-body text-muted-foreground">
            Bandingkan penginapan dari beberapa penyedia dalam satu pencarian, lalu pesan dengan
            harga yang sudah pasti.
          </p>
        </div>

        <div className="mt-10">
          <SearchBar />
        </div>
      </section>

      <section
        aria-labelledby="cara-kerja"
        className="mx-auto max-w-content px-4 pb-12 sm:px-6 sm:pb-16"
      >
        <h2 id="cara-kerja" className="font-display text-h2">
          Kenapa hasilnya berbeda
        </h2>

        {/* Tanpa kartu: pemisah dan jarak sudah cukup membentuk kolom, dan
            menaruh kartu di sini akan menumpuknya dengan kartu hasil
            pencarian di halaman berikutnya. */}
        <ul className="mt-8 grid gap-8 border-t border-border pt-8 sm:grid-cols-3">
          {SUPPORTING.map((item) => (
            <li key={item.title} className="flex flex-col gap-3">
              <item.icon className="size-5 text-muted-foreground" aria-hidden="true" />
              <h3 className="text-h3 font-medium">{item.title}</h3>
              <p className="text-small text-muted-foreground">{item.body}</p>
            </li>
          ))}
        </ul>
      </section>
    </>
  )
}
