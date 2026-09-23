'use client'

import { Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'

/**
 * Pengalih tema.
 *
 * Ikon baru dirender setelah halaman terhidrasi. Tema tersimpan hanya
 * diketahui di sisi klien, jadi merendernya saat server — yang tidak tahu
 * pilihan pengguna — menghasilkan ketidakcocokan hidrasi, dan React membuang
 * seluruh pohon lalu merendernya ulang.
 *
 * Keadaan "sudah terhidrasi" dibaca lewat useSyncExternalStore, bukan
 * useState di dalam useEffect. Keduanya menghasilkan nilai yang sama, tetapi
 * yang kedua memicu render berantai: render pertama, efek, setState, render
 * kedua. Yang ini memberi nilai yang benar pada render pertama di klien.
 */

/** Tidak ada yang perlu dilanggani: nilainya tidak pernah berubah lagi. */
const neverChanges = () => () => undefined

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  const hydrated = useSyncExternalStore(
    neverChanges,
    () => true,
    () => false,
  )

  const isDark = resolvedTheme === 'dark'

  // Nama tombol ikut dijaga, bukan hanya ikonnya. Nama yang menyebut tema
  // sekarang adalah tebakan sebelum hidrasi, dan tebakan yang meleset
  // menghasilkan ketidakcocokan hidrasi — React tidak memperbaiki atribut
  // yang berbeda, jadi yang tertinggal adalah nama yang salah bagi pengguna
  // pembaca layar.
  const label = hydrated
    ? isDark
      ? 'Ganti ke tampilan terang'
      : 'Ganti ke tampilan gelap'
    : 'Ganti tema tampilan'

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      onClick={() => {
        setTheme(isDark ? 'light' : 'dark')
      }}
    >
      {hydrated ? isDark ? <Sun /> : <Moon /> : <span className="size-4" aria-hidden="true" />}
    </Button>
  )
}
