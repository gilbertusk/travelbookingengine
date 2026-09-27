import { err, ok, type Result } from '@tbe/shared-kernel'

/**
 * Tamu yang menginap.
 *
 * Satu tamu utama dengan nama dan surel, ditambah jumlah tamu seluruhnya.
 * Tidak ada daftar nama tamu lain: tidak satu pun supplier simulasi memintanya,
 * dan setiap nama tambahan adalah data pribadi tambahan yang harus dijaga
 * (NFR-15) tanpa ada yang memakainya.
 *
 * Jumlah tamu yang dibawa peristiwa `booking.created` adalah [GuestDetails.count],
 * bukan panjang daftar apa pun.
 */

/**
 * Batas tamu per pemesanan. Satu pemesanan adalah satu kamar di MVP ini
 * (PRD Bab 11: pemesanan multi-kamar di luar lingkup), dan tidak ada room type
 * di katalog simulasi yang menampung lebih dari delapan orang.
 */
export const MAX_GUESTS = 8

const MAX_NAME_LENGTH = 120

/**
 * Pemeriksaan surel yang sengaja longgar. Kebenaran alamat hanya dapat
 * dibuktikan dengan mengirim surel ke sana; regex yang lebih ketat hanya
 * menolak alamat sah yang kebetulan tidak dibayangkan penulisnya.
 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface LeadGuest {
  readonly fullName: string
  readonly email: string
}

export interface GuestDetails {
  readonly leadGuest: LeadGuest
  readonly count: number
}

export type GuestDetailsError =
  | { readonly kind: 'invalid_name' }
  | { readonly kind: 'invalid_email' }
  | { readonly kind: 'invalid_count'; readonly count: number }

export function guestDetails(input: {
  readonly fullName: string
  readonly email: string
  readonly count: number
}): Result<GuestDetails, GuestDetailsError> {
  const fullName = input.fullName.trim()
  if (fullName.length === 0 || fullName.length > MAX_NAME_LENGTH) {
    return err({ kind: 'invalid_name' })
  }

  const email = input.email.trim()
  if (!EMAIL.test(email)) return err({ kind: 'invalid_email' })

  if (!Number.isInteger(input.count) || input.count < 1 || input.count > MAX_GUESTS) {
    return err({ kind: 'invalid_count', count: input.count })
  }

  return ok({ leadGuest: { fullName, email }, count: input.count })
}
