import { publicConfig } from '@/config'

/**
 * Halaman bayar Midtrans Snap (FR-19, keputusan Q1).
 *
 * **Popup lebih dulu.** Pengguna tetap di halaman pemesanannya — ringkasan,
 * hitung mundur, dan jalan kembali tidak hilang. Halaman Snap penuh dipakai
 * hanya bila popup tidak tersedia: client key tidak diatur, atau skrip Snap
 * gagal dimuat.
 *
 * **Callback klien BUKAN penentu keberhasilan.** `onSuccess` dari Snap hanya
 * berarti peramban pengguna diberi tahu sesuatu; uang dianggap diterima ketika
 * notifikasi bertanda tangan sampai di payment-service. Hasil di sini dipakai
 * untuk SATU hal: ke mana pengguna dipindahkan berikutnya — halaman status,
 * yang membaca kebenarannya dari server.
 */

export type SnapOutcome = 'success' | 'pending' | 'error' | 'closed'

interface SnapCallbacks {
  onSuccess?: () => void
  onPending?: () => void
  onError?: () => void
  onClose?: () => void
}

interface SnapGlobal {
  pay(token: string, callbacks: SnapCallbacks): void
}

declare global {
  interface Window {
    snap?: SnapGlobal
  }
}

/** Kunci sessionStorage: pemesanan yang sedang dibayar, untuk kembali dari Snap penuh. */
export const PAYING_KEY = 'tbe:paying'

let loading: Promise<boolean> | undefined

/** Memuat skrip Snap sekali. `false` bila tidak tersedia — pemanggil memakai halaman penuh. */
export async function loadSnap(
  config: { readonly clientKey?: string | undefined; readonly scriptUrl: string } = {
    clientKey: publicConfig.midtransClientKey,
    scriptUrl: publicConfig.snapScriptUrl,
  },
): Promise<boolean> {
  if (window.snap !== undefined) return true
  const { clientKey } = config
  if (clientKey === undefined) return false

  loading ??= new Promise<boolean>((resolve) => {
    const script = document.createElement('script')
    script.src = config.scriptUrl
    script.async = true
    script.dataset.clientKey = clientKey
    script.onload = () => {
      resolve(window.snap !== undefined)
    }
    script.onerror = () => {
      // Dibuang supaya percobaan berikutnya memuat ulang, bukan mewarisi kegagalan.
      script.remove()
      loading = undefined
      resolve(false)
    }
    document.head.append(script)
  })

  return await loading
}

/** Membuka popup dan menunggu pengguna selesai dengannya. */
export async function openSnap(token: string, snap: SnapGlobal): Promise<SnapOutcome> {
  return await new Promise<SnapOutcome>((resolve) => {
    snap.pay(token, {
      onSuccess: () => {
        resolve('success')
      },
      onPending: () => {
        resolve('pending')
      },
      onError: () => {
        resolve('error')
      },
      onClose: () => {
        resolve('closed')
      },
    })
  })
}

/** Nilai parameter `bayar` di halaman status untuk setiap hasil popup. */
export const RETURN_PARAM: Readonly<Record<SnapOutcome, string>> = {
  success: 'selesai',
  pending: 'tertunda',
  error: 'gagal',
  closed: 'ditutup',
}

/**
 * Status transaksi dari URL kembalian Snap penuh menjadi nilai `bayar` yang
 * sama. Midtrans menambahkan `transaction_status` ke Finish URL.
 */
export function returnParamOf(transactionStatus: string | null): string {
  switch (transactionStatus) {
    case 'settlement':
    case 'capture':
      return RETURN_PARAM.success
    case 'pending':
      return RETURN_PARAM.pending
    case 'deny':
    case 'cancel':
    case 'expire':
    case 'failure':
      return RETURN_PARAM.error
    default:
      return RETURN_PARAM.closed
  }
}

/** Untuk uji: melupakan skrip yang sedang dimuat. */
export function resetSnapLoader(): void {
  loading = undefined
}
