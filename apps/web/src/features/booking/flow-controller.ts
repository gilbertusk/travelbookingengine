import { ApiError } from '@/lib/api-error'
import type { Offer } from '@/features/search/types'
import type { OfferTermsInput, PriceCheckInput } from './api'
import { clockOffset } from './countdown'
import {
  decide,
  idempotencyStorageKey,
  stepForError,
  type FlowStep,
  type RetryAction,
} from './flow'
import { bookingStatusHref, selectionKey, withBooking, type Selection } from './selection'
import { RETURN_PARAM, type SnapOutcome } from './snap'
import type { Booking, GuestInput, PaymentStart } from './types'

/**
 * Pengendali alur pemesanan — di LUAR React.
 *
 * Alurnya rangkaian langkah asinkron yang saling memanggil: price check bisa
 * berakhir di hold, hold bisa kembali ke price check bila harga bergerak,
 * persetujuan harga bisa memunculkan dialog lagi. Ditulis sebagai hook, setiap
 * langkah menjadi `useCallback` yang bergantung pada yang lain lewat ref, dan
 * aturan React tentang ref saat render dilanggar di mana-mana. Di sini ia
 * objek biasa dengan keadaan yang dapat dilanggani; hook-nya tinggal
 * `useSyncExternalStore` (use-booking-flow.ts), dan seluruh alurnya dapat
 * diuji tanpa merender satu komponen pun.
 *
 * Yang dijaga di sini:
 *
 * - **Satu kunci idempotensi per pilihan kamar**, di sessionStorage. Klik
 *   ganda, jawaban yang hilang, dan muat ulang di tengah price check mengirim
 *   kunci yang sama — satu pemesanan (FR-18).
 * - **Selisih jam server** dihitung dari jawaban pertama yang membawa
 *   `heldUntil`, lalu dipertahankan. Menghitungnya ulang di setiap jawaban
 *   membuat hitung mundur melompat mengikuti waktu tempuh jaringan.
 * - **Data tamu tidak disimpan di peramban.** Pemesanan yang dimuat ulang dan
 *   masih butuh price check meminta pengguna mengisinya lagi.
 */

export interface FlowState {
  readonly step: FlowStep
  /** Pemesanan terakhir yang diketahui; sumber ringkasan harga setelah dibuat. */
  readonly booking: Booking | undefined
  readonly offsetMs: number
  readonly rateDialogOpen: boolean
  readonly accepting: boolean
  readonly paying: boolean
  /** Jendela pembayaran ditutup sebelum selesai. */
  readonly paymentClosed: boolean
}

export type PaymentOutcome = SnapOutcome | 'redirected'

export interface FlowDeps {
  readonly api: {
    readonly priceCheck: (input: PriceCheckInput) => Promise<Booking>
    readonly acceptPrice: (bookingId: string) => Promise<Booking>
    readonly placeHold: (bookingId: string, unitsLeft: number) => Promise<Booking>
    readonly fetchBooking: (bookingId: string, signal?: AbortSignal) => Promise<Booking>
    readonly startPayment: (bookingId: string) => Promise<PaymentStart>
  }
  readonly navigate: {
    readonly replace: (href: string) => void
    readonly push: (href: string) => void
  }
  /** Membuka halaman bayar: popup, atau berpindah ke halaman Snap penuh. */
  readonly openPayment: (payment: PaymentStart, bookingId: string) => Promise<PaymentOutcome>
  readonly storage: {
    readonly get: (key: string) => string | undefined
    readonly set: (key: string, value: string) => void
    readonly remove: (key: string) => void
  }
  readonly now: () => number
  readonly newKey: () => string
  readonly currentParams: () => URLSearchParams
}

export interface BookingFlowController {
  readonly getState: () => FlowState
  readonly subscribe: (listener: () => void) => () => void
  /** Melanjutkan pemesanan yang sudah dibuat (setelah dimuat ulang). */
  readonly resume: (signal: AbortSignal) => void
  readonly submitGuest: (values: GuestInput) => void
  readonly acceptNewPrice: () => void
  readonly setRateDialogOpen: (open: boolean) => void
  readonly pay: () => void
  readonly retry: () => void
  readonly expire: () => void
}

const RECHECK_FAILED =
  'Harga yang kamu setujui belum dapat diverifikasi ulang ke penyedia. Belum ada yang ditagih — coba lagi sebentar.'

export function createBookingFlow(
  selection: Selection,
  offer: Offer | undefined,
  deps: FlowDeps,
): BookingFlowController {
  return new BookingFlow(selection, offer, deps)
}

/**
 * Kelas, bukan penutupan fungsi: setiap langkah metodenya sendiri yang dapat
 * dibaca terpisah. API publiknya properti panah, supaya aman dipisahkan dari
 * objeknya — komponen meneruskannya langsung sebagai `onClick`.
 */
class BookingFlow implements BookingFlowController {
  private state: FlowState
  private readonly listeners = new Set<() => void>()
  private guest: GuestInput | undefined
  private offsetKnown = false
  private readonly selection: Selection
  private readonly offer: Offer | undefined
  private readonly deps: FlowDeps

  constructor(selection: Selection, offer: Offer | undefined, deps: FlowDeps) {
    this.selection = selection
    this.offer = offer
    this.deps = deps
    this.state = {
      step:
        selection.bookingId === undefined
          ? { step: 'details' }
          : { step: 'working', label: 'Memuat pemesananmu…' },
      booking: undefined,
      offsetMs: 0,
      rateDialogOpen: false,
      accepting: false,
      paying: false,
      paymentClosed: false,
    }
  }

  readonly getState = (): FlowState => this.state

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  readonly resume = (signal: AbortSignal): void => {
    const id = this.selection.bookingId
    if (id === undefined || this.state.booking !== undefined) return

    void this.timed(async () => await this.deps.api.fetchBooking(id, signal)).then(
      async (loaded) => {
        // `false`: pemesanan yang menunggu price check ulang boleh diperiksa
        // lagi — dan tanpa data tamu, itu berarti formulirnya ditampilkan.
        await this.apply(loaded, false)
      },
      (error: unknown) => {
        if (!signal.aborted) this.fail(error, 'check')
      },
    )
  }

  readonly submitGuest = (values: GuestInput): void => {
    this.guest = values
    void this.check(false)
  }

  readonly acceptNewPrice = (): void => {
    const target = this.state.booking
    if (target === undefined) return
    this.update({ accepting: true })

    void this.timed(async () => await this.deps.api.acceptPrice(target.id))
      .then(async (accepted) => {
        await this.apply(accepted, false)
      })
      .catch((error: unknown) => {
        this.update({ rateDialogOpen: false })
        this.fail(error, 'check')
      })
      .finally(() => {
        this.update({ accepting: false })
      })
  }

  readonly setRateDialogOpen = (open: boolean): void => {
    this.update({ rateDialogOpen: open })
  }

  readonly pay = (): void => {
    const target = this.state.booking
    if (target === undefined || this.state.paying) return
    void this.startPayment(target)
  }

  readonly retry = (): void => {
    const { step, booking } = this.state
    if (step.step !== 'failed') return
    if (step.retry === 'hold' && booking !== undefined) void this.hold(booking)
    else if (step.retry === 'pay' && booking !== undefined) this.setStep({ step: 'held', booking })
    else void this.check(false)
  }

  readonly expire = (): void => {
    this.setStep({ step: 'expired' })
  }

  private update(patch: Partial<FlowState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  private setStep(step: FlowStep): void {
    this.update({ step })
  }

  private fail(error: unknown, action: RetryAction): void {
    const next = stepForError(error, action)
    if (next !== undefined) this.setStep(next)
  }

  /** Menjalankan satu permintaan, mencatat pemesanannya dan waktu tempuhnya. */
  private async timed(call: () => Promise<Booking>): Promise<Booking> {
    const sentAt = this.deps.now()
    const booking = await call()
    const receivedAt = this.deps.now()
    this.update({ booking })
    if (!this.offsetKnown && booking.heldUntil !== null) {
      this.offsetKnown = true
      this.update({ offsetMs: clockOffset(booking.serverTime, sentAt, receivedAt) })
    }
    return booking
  }

  private async apply(booking: Booking, rechecked: boolean): Promise<void> {
    const decision = decide(booking)

    switch (decision.step) {
      case 'do_hold':
        this.update({ rateDialogOpen: false })
        await this.hold(booking)
        return
      case 'do_recheck':
        if (rechecked) this.setStep({ step: 'failed', retry: 'check', message: RECHECK_FAILED })
        else await this.check(true)
        return
      case 'rate_changed':
        this.update({ step: decision, rateDialogOpen: true })
        return
      case 'paid':
        this.setStep(decision)
        this.deps.navigate.replace(bookingStatusHref(booking.id))
        return
      default:
        this.setStep(decision)
    }
  }

  private checkInput(values: GuestInput): PriceCheckInput | undefined {
    const { offer, selection } = this
    if (offer === undefined) return undefined

    return {
      idempotencyKey: this.idempotencyKey(),
      supplier: offer.supplier,
      propertyId: offer.supplierPropertyId,
      city: selection.criteria.city,
      ratePlanRef: offer.supplierRatePlanId,
      offer: offerTermsOf(offer),
      checkIn: selection.criteria.checkIn,
      checkOut: selection.criteria.checkOut,
      guests: selection.criteria.guests,
      guest: values,
      displayedTotal: offer.total,
    }
  }

  private async check(rechecked: boolean): Promise<void> {
    const input = this.guest === undefined ? undefined : this.checkInput(this.guest)
    if (input === undefined) {
      // Dimuat ulang tanpa data tamu: minta lagi, jangan menebak.
      this.setStep({ step: 'details' })
      return
    }

    this.setStep({ step: 'working', label: 'Memeriksa harga ke penyedia…' })
    try {
      const checked = await this.timed(async () => await this.deps.api.priceCheck(input))
      this.deps.navigate.replace(withBooking(this.deps.currentParams(), checked.id))
      await this.apply(checked, rechecked)
    } catch (error) {
      if (isCode(error, 'IDEMPOTENCY_KEY_REUSED') && !rechecked) {
        // Pilihan yang sama dengan isi berbeda: kunci baru, sekali saja.
        this.deps.storage.remove(this.storageKey())
        await this.check(true)
        return
      }
      this.fail(error, 'check')
    }
  }

  private async hold(target: Booking): Promise<void> {
    this.setStep({ step: 'working', label: 'Menahan kamar untukmu…' })
    try {
      const unitsLeft = this.offer?.unitsLeft ?? 1
      const held = await this.timed(async () => await this.deps.api.placeHold(target.id, unitsLeft))
      await this.apply(held, false)
    } catch (error) {
      if (isCode(error, 'PRICE_CHANGED')) {
        // Harga bergerak tepat saat hold: price check ulang memunculkan dialognya.
        await this.check(false)
        return
      }
      if (isCode(error, 'HOLD_IN_PROGRESS') && (await this.reload(target.id))) return
      this.fail(error, 'hold')
    }
  }

  /** Membaca ulang keadaan pemesanan dan mengikutinya. `false` bila gagal dibaca. */
  private async reload(bookingId: string): Promise<boolean> {
    try {
      const current = await this.timed(async () => await this.deps.api.fetchBooking(bookingId))
      await this.apply(current, true)
      return true
    } catch {
      return false
    }
  }

  private async startPayment(target: Booking): Promise<void> {
    this.update({ paying: true, paymentClosed: false })
    try {
      const payment = await this.deps.api.startPayment(target.id)
      const outcome = await this.deps.openPayment(payment, target.id)
      if (outcome === 'closed') this.update({ paymentClosed: true })
      else if (outcome !== 'redirected') {
        this.deps.navigate.push(bookingStatusHref(target.id, RETURN_PARAM[outcome]))
      }
    } catch (error) {
      await this.paymentFailed(error, target)
    } finally {
      this.update({ paying: false })
    }
  }

  private async paymentFailed(error: unknown, target: Booking): Promise<void> {
    if (isCode(error, 'ALREADY_PAID')) {
      this.deps.navigate.push(bookingStatusHref(target.id))
      return
    }
    if (isCode(error, 'NOT_PAYABLE') && (await this.reload(target.id))) return
    this.fail(error, 'pay')
  }

  private storageKey(): string {
    return idempotencyStorageKey(selectionKey(this.selection))
  }

  private idempotencyKey(): string {
    const existing = this.deps.storage.get(this.storageKey())
    if (existing !== undefined) return existing

    const fresh = this.deps.newKey()
    this.deps.storage.set(this.storageKey(), fresh)
    return fresh
  }
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof ApiError && error.code === code
}

/** Ketentuan tawaran sebagai bahan e-voucher (Step 23). */
export function offerTermsOf(offer: Offer): OfferTermsInput {
  return {
    roomTypeName: offer.roomTypeName,
    ratePlanName: offer.ratePlanName,
    breakfastIncluded: offer.breakfastIncluded,
    cancellationPolicy: !offer.refundable
      ? { refundable: false }
      : offer.freeCancellationDays === undefined
        ? { refundable: true }
        : { refundable: true, freeCancellationDays: offer.freeCancellationDays },
  }
}
