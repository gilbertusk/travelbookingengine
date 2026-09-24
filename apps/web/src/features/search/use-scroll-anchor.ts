'use client'

import { useLayoutEffect, useRef, type RefObject } from 'react'

/**
 * Menahan posisi baca ketika hasil baru menyisip di atasnya.
 *
 * Ini kesalahan yang paling merusak kesan pada layar pencarian, dan ia tidak
 * terlihat sampai ada supplier lambat: pengguna sedang membaca kartu ketiga,
 * LUNA akhirnya menjawab, satu hotel yang lebih murah menyisip di posisi
 * pertama — dan semua yang sedang dibaca terdorong ke bawah. Jari yang sudah
 * bergerak menuju satu kartu mendarat di kartu lain.
 *
 * Yang TIDAK menyelesaikannya:
 *
 *   - Menambahkan hasil baru di bawah saja. Itu merusak pengurutan, dan
 *     pengurutan menurut harga adalah alasan utama orang memakai agregator
 *   - `overflow-anchor` CSS. Ia hanya bekerja untuk kontainer yang menggulir
 *     sendiri, sedangkan halaman hasil menggulir lewat dokumen
 *   - Menunda pembaruan sampai pengguna berhenti menggulir. Menunda
 *     informasi yang sudah ada hanya memindahkan masalahnya
 *
 * Yang dipakai: mengukur jarak satu elemen jangkar dari puncak viewport
 * SEBELUM DOM berubah, lalu menggulir balik sebanyak selisihnya sesudahnya.
 * Elemen jangkarnya adalah kartu pertama yang benar-benar terlihat — bukan
 * kartu pertama dalam daftar, yang mungkin sudah jauh di atas layar.
 *
 * `useLayoutEffect`, bukan `useEffect`: koreksinya harus terjadi sebelum
 * peramban melukis. Dengan `useEffect`, pengguna melihat lompatannya dulu
 * lalu terkoreksi — yang justru lebih mengganggu daripada lompatan itu sendiri.
 */

export interface ScrollAnchorOptions {
  /** Berubah setiap kali daftar dapat berubah. Biasanya jumlah atau versi data. */
  readonly token: unknown
  /** Dimatikan saat daftar sedang dimuat pertama kali — belum ada yang dibaca. */
  readonly enabled?: boolean
}

export function useScrollAnchor(
  container: RefObject<HTMLElement | null>,
  options: ScrollAnchorOptions,
): void {
  const previous = useRef<{ key: string; top: number } | undefined>(undefined)
  const enabled = options.enabled ?? true

  // Dijalankan SETIAP render, sebelum yang berikutnya. Yang direkam adalah
  // keadaan sesaat sebelum DOM berikutnya dilukis.
  useLayoutEffect(() => {
    if (!enabled) {
      previous.current = undefined
      return
    }

    const anchor = previous.current
    previous.current = measure(container.current)

    if (anchor === undefined) return

    const now = findByKey(container.current, anchor.key)
    if (now === null) return

    const shift = now.getBoundingClientRect().top - anchor.top
    if (Math.abs(shift) < 1) return

    // `scrollBy` tanpa perilaku halus: ini koreksi, bukan animasi. Gulir
    // beranimasi di sini akan terlihat seperti halaman yang bergerak sendiri.
    window.scrollBy(0, shift)
  }, [container, options.token, enabled])
}

/**
 * Kartu pertama yang puncaknya masih di dalam atau tepat di atas viewport.
 *
 * Bukan kartu pertama dalam daftar: setelah pengguna menggulir, kartu pertama
 * berada jauh di atas layar, dan menjangkarkan padanya tetap menghasilkan
 * pergeseran yang terlihat.
 */
function measure(container: HTMLElement | null): { key: string; top: number } | undefined {
  if (container === null) return undefined

  for (const element of container.querySelectorAll<HTMLElement>('[data-anchor-key]')) {
    const top = element.getBoundingClientRect().top
    if (top < 0) continue

    const key = element.dataset.anchorKey
    if (key === undefined) continue

    return { key, top }
  }

  return undefined
}

function findByKey(container: HTMLElement | null, key: string): HTMLElement | null {
  if (container === null) return null

  // `CSS.escape` tidak selalu ada di lingkungan uji, dan kunci yang dipakai
  // hanya berisi pengenal properti. Pencarian manual menghindari seluruh
  // persoalan pelolosan selektor.
  for (const element of container.querySelectorAll<HTMLElement>('[data-anchor-key]')) {
    if (element.dataset.anchorKey === key) return element
  }

  return null
}
