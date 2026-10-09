import type { BookingListItem, RefundQuote } from './types'

/**
 * Kalimat untuk daftar dan detail pemesanan (Step 26).
 *
 * Status selalu disebut dengan kata-kata; warna hanya mengulang artinya
 * (DESIGN-SYSTEM.md bagian 9). Tenggat selalu berupa tanggal dan jam konkret
 * di zona properti, tidak pernah "24 jam sebelum check-in" — kalimat kedua
 * memaksa pengguna berhitung, dan hitungannya sering salah karena zona waktu.
 */

export type StatusTone = 'success' | 'waiting' | 'refund' | 'review' | 'ended'

/** Apa yang terjadi pada uang pengguna — dirangkai menjadi kalimat oleh komponen. */
export type MoneyState =
  'not_charged' | 'refund_pending' | 'refunded' | 'nothing_back' | 'held_for_review' | 'paid'

export interface StatusLabel {
  readonly label: string
  readonly tone: StatusTone
  readonly money: MoneyState
}

type StatusInput = Pick<BookingListItem, 'status' | 'refund' | 'review' | 'cancellation'>

export function statusOf(booking: StatusInput): StatusLabel {
  switch (booking.status) {
    case 'DRAFT':
    case 'PRICE_CHECKED':
      return { label: 'Belum dipesan', tone: 'ended', money: 'not_charged' }
    case 'HELD':
      return { label: 'Menunggu pembayaran', tone: 'waiting', money: 'not_charged' }
    case 'PAID':
      return { label: 'Menunggu konfirmasi penyedia', tone: 'waiting', money: 'paid' }
    case 'CONFIRMED':
      return { label: 'Terkonfirmasi', tone: 'success', money: 'paid' }
    case 'CANCELLING':
      return booking.cancellation?.step === 'refund'
        ? { label: 'Dibatalkan, dana sedang dikembalikan', tone: 'refund', money: 'refund_pending' }
        : { label: 'Sedang dibatalkan', tone: 'waiting', money: 'paid' }
    case 'CANCELLED':
      return { label: 'Dibatalkan', tone: 'ended', money: cancelledMoney(booking) }
    case 'EXPIRED':
      return { label: 'Waktu pembayaran habis', tone: 'ended', money: 'not_charged' }
    case 'FAILED':
      return { label: 'Tidak dapat dikonfirmasi', tone: 'refund', money: 'refund_pending' }
    case 'REFUNDED':
      return { label: 'Dana sudah dikembalikan', tone: 'refund', money: 'refunded' }
    case 'NEEDS_REVIEW':
      return {
        label:
          booking.review === 'cancellation'
            ? 'Pembatalan sedang diperiksa'
            : 'Sedang diperiksa tim kami',
        tone: 'review',
        money: 'held_for_review',
      }
  }
}

function cancelledMoney(booking: StatusInput): MoneyState {
  const cancellation = booking.cancellation
  if (cancellation === null) return 'not_charged'

  return cancellation.refund.amountMinor > 0 ? 'refunded' : 'nothing_back'
}

const INDONESIAN_ZONES = new Set(['WIB', 'WITA', 'WIT'])

/** WIB/WITA/WIT untuk Indonesia; selain itu "waktu <kota>", bukan "GMT+9". */
export function zoneLabel(timeZone: string, at: Date): string {
  const short = new Intl.DateTimeFormat('id-ID', { timeZone, timeZoneName: 'short' })
    .formatToParts(at)
    .find((part) => part.type === 'timeZoneName')?.value

  if (short !== undefined && INDONESIAN_ZONES.has(short)) return short

  const city = timeZone.split('/').at(-1) ?? timeZone

  return `waktu ${city.replaceAll('_', ' ')}`
}

const MINUTE_MS = 60_000

/**
 * Titik waktu terakhir sebuah tenggat, di zona properti.
 *
 * Tenggat jatuh tepat tengah malam awal sebuah hari, dan "sampai 7 Nov pukul
 * 00.00" dibaca banyak orang sebagai sepanjang 7 November. Yang ditampilkan
 * adalah menit terakhir sebelumnya.
 */
export function formatDeadline(iso: string, timeZone: string): string {
  const at = new Date(Date.parse(iso) - MINUTE_MS)
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('id-ID', {
      timeZone,
      weekday: 'long',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  )

  return (
    `${String(parts.weekday)}, ${String(parts.day)} ${String(parts.month)} ${String(parts.year)} ` +
    `pukul ${String(parts.hour)}.${String(parts.minute)} ${zoneLabel(timeZone, at)}`
  )
}

/** Kebijakan pembatalan sebagai kalimat, satu per jenjang, dengan tenggat konkret. */
export function policyLines(quote: Pick<RefundQuote, 'tiers' | 'timeZone'>): string[] {
  if (quote.tiers.every((tier) => tier.percent === 0)) {
    return ['Rate ini tidak dapat dikembalikan bila dibatalkan.']
  }

  return quote.tiers.map((tier) => {
    if (tier.percent === 0) return 'Setelah itu, tidak ada dana yang kembali.'

    const deadline = formatDeadline(tier.until, quote.timeZone)

    return tier.percent === 100
      ? `Gratis dibatalkan sampai ${deadline}.`
      : `Dana kembali ${String(tier.percent)}% bila dibatalkan sampai ${deadline}.`
  })
}
