'use client'

import { LogOut, User as UserIcon } from 'lucide-react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { useLogout, useSession } from '@/features/auth/use-auth'

/**
 * Menu akun.
 *
 * Tiga keadaan yang berbeda, dan ketiganya harus ditangani: sesi sedang
 * dipulihkan, tidak ada sesi, dan ada sesi. Melewatkan yang pertama membuat
 * tombol "Masuk" berkedip sesaat pada setiap pemuatan halaman bagi pengguna
 * yang sebenarnya sudah masuk.
 */
export function AccountMenu() {
  const session = useSession()
  const logoutMutation = useLogout()

  if (session.isPending) return <Skeleton className="h-9 w-24" />

  const user = session.data

  if (user === null || user === undefined) {
    return (
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link href="/masuk">Masuk</Link>
        </Button>
        {/* Sekunder, bukan aksen. Aksen dipakai untuk satu aksi utama per
            layar, dan pada setiap halaman aksi itu ada di isinya — mencari,
            memesan, membayar — bukan di header. Tombol aksen yang menetap di
            header bersaing dengan aksi sesungguhnya di setiap halaman. */}
        <Button asChild variant="secondary" size="sm">
          <Link href="/daftar">Daftar</Link>
        </Button>
      </div>
    )
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-2">
          <UserIcon />
          <span className="max-w-32 truncate">{user.name}</span>
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-60 p-2">
        <div className="px-2 py-2">
          <p className="truncate text-small font-medium">{user.name}</p>
          <p className="truncate text-caption text-muted-foreground">{user.email}</p>
        </div>

        <Separator className="my-2" />

        <Button asChild variant="ghost" size="sm" className="w-full justify-start">
          <Link href="/bookings">Pemesananku</Link>
        </Button>

        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start"
          disabled={logoutMutation.isPending}
          onClick={() => {
            logoutMutation.mutate()
          }}
        >
          <LogOut />
          {logoutMutation.isPending ? 'Keluar…' : 'Keluar'}
        </Button>
      </PopoverContent>
    </Popover>
  )
}
