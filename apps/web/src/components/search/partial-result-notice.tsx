'use client'

import { Loader2 } from 'lucide-react'
import { pendingSuppliers, respondedSuppliers, type SearchMeta } from '@/features/search/types'

/**
 * Keadaan kelima: sebagian penyedia sudah menjawab, sebagian belum.
 *
 * DESIGN-SYSTEM.md bagian 7 menyebutnya keadaan yang PERTAMA KALI dilihat
 * pengguna, jadi ia dirancang serius — bukan ditambahkan sebagai peringatan
 * kuning di atas daftar.
 *
 * Tiga keputusan di dalamnya:
 *
 * 1. **Menyebut angka, bukan "sedang memuat".** "3 dari 5 penyedia" memberi
 *    tahu pengguna bahwa daftarnya belum lengkap DAN bahwa sebagian besar
 *    sudah ada. "Sedang memuat" tidak mengatakan keduanya.
 *
 * 2. **Diumumkan lewat `aria-live="polite"`.** Hasil yang bertambah tanpa
 *    pengumuman berarti pengguna pembaca layar tidak pernah tahu daftarnya
 *    berubah — ia membaca sepuluh hasil, dan tiga hotel termurah yang datang
 *    belakangan tidak pernah disebut.
 *
 * 3. **Tidak menghilang begitu saja.** Ketika seluruh penyedia sudah
 *    menjawab, yang muncul adalah keterangan bahwa daftarnya lengkap —
 *    bukan ruang kosong. Pengguna yang tadi melihat "3 dari 5" perlu tahu
 *    bahwa angka itu sudah selesai berubah.
 */

export interface PartialResultNoticeProps {
  readonly meta: SearchMeta
  readonly isRefreshing: boolean
}

export function PartialResultNotice({ meta, isRefreshing }: PartialResultNoticeProps) {
  const responded = respondedSuppliers(meta)
  const pending = pendingSuppliers(meta)
  const total = responded + pending

  return (
    <div
      // `polite`: diumumkan setelah pembaca layar selesai dengan kalimat yang
      // sedang dibacanya. `assertive` akan memotong pengguna di tengah nama
      // hotel setiap kali satu penyedia menjawab.
      aria-live="polite"
      aria-atomic="true"
      className="flex items-center gap-3 rounded-lg border border-border bg-muted px-4 py-3 text-sm"
    >
      {meta.partial || isRefreshing ? (
        <Loader2
          className="size-4 shrink-0 text-muted-foreground motion-safe:animate-spin"
          aria-hidden="true"
        />
      ) : null}

      <p className="text-muted-foreground">{message(meta, responded, total, isRefreshing)}</p>
    </div>
  )
}

function message(
  meta: SearchMeta,
  responded: number,
  total: number,
  isRefreshing: boolean,
): string {
  if (isRefreshing) return 'Memperbarui hasil…'

  if (meta.partial) {
    const timedOut = meta.suppliersTimedOut.length

    return timedOut > 0
      ? `${String(responded)} dari ${String(total)} penyedia sudah menjawab. Sisanya masih dicari dan akan muncul sendiri.`
      : `${String(responded)} dari ${String(total)} penyedia sudah menjawab. Sisanya sedang tidak dapat dihubungi.`
  }

  if (meta.source === 'cache')
    return `Seluruh ${String(total)} penyedia sudah menjawab. ${freshness(meta.ageMs)}`

  return `Seluruh ${String(total)} penyedia sudah menjawab.`
}

/**
 * Umur data dari cache, dalam bahasa manusia.
 *
 * Disebutkan karena klien yang tidak tahu datanya berumur empat menit tidak
 * dapat memutuskan apa pun tentangnya — dan harga hotel memang berubah dalam
 * hitungan menit.
 */
function freshness(ageMs: number | undefined): string {
  if (ageMs === undefined) return ''

  const minutes = Math.floor(ageMs / 60_000)
  if (minutes < 1) return 'Baru diperbarui.'

  return `Diperbarui ${String(minutes)} menit lalu.`
}
