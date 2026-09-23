import { AlertTriangle, Inbox } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { humanMessage } from '@/lib/api-error'
import { EmptyState, ErrorState, LoadingState } from './states'

/**
 * Pembungkus yang memilih satu dari empat keadaan.
 *
 * Tanpa ini, setiap halaman menulis rantai `if (isLoading) … if (error) …`
 * sendiri, dan perbedaan kecil di antara mereka menumpuk sampai tidak ada dua
 * halaman yang berperilaku sama. Yang dipusatkan di sini adalah urutan
 * pemeriksaannya, dan urutan itu punya satu keputusan yang mudah salah:
 *
 * **Data yang sudah ada menang atas galat.** Pengambilan ulang yang gagal
 * padahal data lama masih ada tidak boleh mengosongkan layar — hasil pencarian
 * yang sudah dibaca pengguna hilang begitu saja hanya karena permintaan latar
 * belakang gagal.
 */
export interface AsyncStateProps<T> {
  readonly data: T | undefined
  readonly isLoading: boolean
  readonly error: unknown
  readonly onRetry?: () => void
  /** Dianggap kosong bila fungsi ini mengembalikan true. */
  readonly isEmpty?: (data: T) => boolean
  readonly skeleton: ReactNode
  readonly empty?: {
    readonly title: string
    readonly description: string
    readonly action?: ReactNode
  }
  readonly children: (data: T) => ReactNode
}

export function AsyncState<T>({
  data,
  isLoading,
  error,
  onRetry,
  isEmpty,
  skeleton,
  empty,
  children,
}: AsyncStateProps<T>) {
  if (data !== undefined) {
    if (isEmpty?.(data) === true) {
      return (
        <EmptyState
          icon={<Inbox />}
          title={empty?.title ?? 'Belum ada apa-apa di sini'}
          description={empty?.description ?? 'Saat ada isinya, ia akan muncul di halaman ini.'}
          {...(empty?.action === undefined ? {} : { action: empty.action })}
        />
      )
    }

    return <>{children(data)}</>
  }

  if (isLoading) return <LoadingState>{skeleton}</LoadingState>

  if (error !== null && error !== undefined) {
    return (
      <ErrorState
        icon={<AlertTriangle />}
        title="Gagal memuat"
        description={humanMessage(error)}
        {...(onRetry === undefined
          ? {}
          : {
              action: (
                <Button variant="secondary" onClick={onRetry}>
                  Coba lagi
                </Button>
              ),
            })}
      />
    )
  }

  return <LoadingState>{skeleton}</LoadingState>
}
