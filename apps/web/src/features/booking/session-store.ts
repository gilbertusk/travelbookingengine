import type { FlowDeps } from './flow-controller'

/**
 * sessionStorage yang tidak pernah melempar. Mode privat yang menolak
 * penyimpanan hanya berarti alurnya tidak bertahan setelah dimuat ulang.
 */
export const sessionStore: FlowDeps['storage'] = {
  get: (key) => {
    try {
      return window.sessionStorage.getItem(key) ?? undefined
    } catch {
      return undefined
    }
  },
  set: (key, value) => {
    try {
      window.sessionStorage.setItem(key, value)
    } catch {
      // lihat di atas
    }
  },
  remove: (key) => {
    try {
      window.sessionStorage.removeItem(key)
    } catch {
      // lihat di atas
    }
  },
}

/**
 * Nama properti dan kamar untuk halaman status.
 *
 * booking-service menyimpan pengenal properti versi supplier, bukan namanya —
 * katalog adalah urusan search-service. Halaman status yang dibuka dari alur
 * pemesanan memakai nama yang sudah dilihat pengguna; yang dibuka langsung
 * (tautan surel, tab lain) jatuh ke kota pemesanannya. Bukan data pribadi.
 */
export interface BookingLabel {
  readonly propertyName: string
  readonly roomName?: string | undefined
}

const labelKey = (bookingId: string) => `tbe:booking-label:${bookingId}`

export function rememberBookingLabel(bookingId: string, label: BookingLabel): void {
  sessionStore.set(labelKey(bookingId), JSON.stringify(label))
}

export function readBookingLabel(bookingId: string): BookingLabel | undefined {
  const raw = sessionStore.get(labelKey(bookingId))
  if (raw === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || !('propertyName' in parsed))
      return undefined
    const { propertyName } = parsed
    if (typeof propertyName !== 'string') return undefined
    const roomName =
      'roomName' in parsed && typeof parsed.roomName === 'string' ? parsed.roomName : undefined
    return { propertyName, roomName }
  } catch {
    return undefined
  }
}
