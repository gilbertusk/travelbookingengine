import { format } from '@tbe/money'
import { err, ok, type Result } from '@tbe/shared-kernel'
import type { CancellationPolicy, OfferTerms, VoucherProperty, VoucherSource } from './voucher.js'

/**
 * Isi e-voucher, sudah dalam bentuk teks yang dicetak.
 *
 * Seluruh keputusan tentang APA yang tertulis di voucher ada di sini, sebagai
 * fungsi murni. Penyusun PDF hanya menata letak; ia tidak memformat uang,
 * tidak menghitung malam, dan tidak memilih kalimat kebijakan pembatalan.
 * Dengan begitu isi voucher dapat diuji tanpa membuka PDF, dan uji PDF cukup
 * membuktikan bahwa isi ini benar-benar sampai ke halaman.
 */

export interface VoucherContent {
  /** Booking reference SUPPLIER — bukti yang sah, dan isi kode QR. */
  readonly bookingReference: string
  readonly bookingId: string
  readonly property: {
    readonly name: string
    readonly address: string
    readonly phone: string
    readonly email: string
  }
  readonly stay: {
    readonly checkIn: string
    readonly checkOut: string
    readonly nights: string
  }
  readonly roomType: string
  readonly ratePlan: string
  readonly guest: { readonly name: string; readonly count: string }
  readonly price: {
    readonly lines: readonly { readonly label: string; readonly amount: string }[]
    readonly total: string
  }
  readonly cancellationPolicy: string
  readonly issuedAt: string
}

export type ComposeRefusal =
  | { readonly kind: 'not_confirmed'; readonly status: string }
  | { readonly kind: 'missing_reference' }

/** Teks untuk bagian yang tidak tercatat. Dinyatakan, bukan dikosongkan. */
export const NOT_RECORDED = 'Tidak tercatat'
const NO_CONTACT = 'Tidak tersedia — hubungi layanan pelanggan'

const MS_PER_DAY = 86_400_000

export function composeVoucher(
  source: VoucherSource,
  property: VoucherProperty,
  issuedAt: Date,
): Result<VoucherContent, ComposeRefusal> {
  if (source.status !== 'CONFIRMED') return err({ kind: 'not_confirmed', status: source.status })

  const reference = source.supplierRef?.trim() ?? ''
  if (reference.length === 0) return err({ kind: 'missing_reference' })

  return ok({
    bookingReference: reference,
    bookingId: source.bookingId,
    property: {
      name: property.name,
      address: [property.address, property.city].filter((part) => part.length > 0).join(', '),
      phone: property.phone ?? NO_CONTACT,
      email: property.email ?? NO_CONTACT,
    },
    stay: {
      checkIn: stayDateLabel(source.checkIn),
      checkOut: stayDateLabel(source.checkOut),
      nights: `${String(nightsBetween(source.checkIn, source.checkOut))} malam`,
    },
    roomType: source.terms?.roomTypeName ?? NOT_RECORDED,
    ratePlan: ratePlanLabel(source.terms),
    guest: { name: source.leadGuestName, count: `${String(source.guestCount)} tamu` },
    price: {
      lines: source.lines.map((line) => ({ label: line.description, amount: format(line.amount) })),
      total: format(source.total),
    },
    cancellationPolicy: cancellationText(source.terms?.cancellationPolicy),
    issuedAt: issuedAtLabel(issuedAt),
  })
}

/**
 * Tanggal menginap dalam bahasa Indonesia.
 *
 * Diformat dengan zona UTC karena nilainya tanggal KALENDER properti yang
 * sengaja disimpan sebagai tengah malam UTC — memformatnya dengan zona mesin
 * menggeser tanggal masuk satu hari di server yang berada di barat Greenwich
 * (NFR-09).
 */
export function stayDateLabel(date: string): string {
  return new Intl.DateTimeFormat('id-ID', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00.000Z`))
}

export function nightsBetween(checkIn: string, checkOut: string): number {
  const start = Date.parse(`${checkIn}T00:00:00.000Z`)
  const end = Date.parse(`${checkOut}T00:00:00.000Z`)

  return Math.round((end - start) / MS_PER_DAY)
}

function ratePlanLabel(terms: OfferTerms | null): string {
  if (terms === null) return NOT_RECORDED

  const breakfast = terms.breakfastIncluded ? 'termasuk sarapan' : 'tanpa sarapan'
  return `${terms.ratePlanName} (${breakfast})`
}

/**
 * Kalimat kebijakan pembatalan.
 *
 * Yang ditulis hanyalah yang dinyatakan supplier saat pemesanan. Tenggat yang
 * tidak disebutkan TIDAK dikarang: voucher yang menjanjikan pembatalan gratis
 * yang tidak pernah dijanjikan supplier adalah sengketa yang menunggu terjadi.
 */
export function cancellationText(policy: CancellationPolicy | undefined): string {
  if (policy === undefined) return `${NOT_RECORDED}. Hubungi layanan pelanggan untuk ketentuannya.`
  if (!policy.refundable) return 'Tidak dapat dibatalkan dengan pengembalian dana.'
  if (policy.freeCancellationDays === undefined) {
    return 'Dapat dibatalkan. Tenggat pembatalan gratis tidak disebutkan penyedia.'
  }

  return (
    `Dapat dibatalkan tanpa biaya sampai ${String(policy.freeCancellationDays)} hari ` +
    'sebelum tanggal masuk, menurut waktu setempat properti.'
  )
}

/** Waktu terbit dengan zonanya tertulis — voucher dibaca di zona mana pun. */
export function issuedAtLabel(at: Date): string {
  const label = new Intl.DateTimeFormat('id-ID', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'UTC',
  }).format(at)

  return `${label} UTC`
}
