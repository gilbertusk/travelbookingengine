import { format } from '@tbe/money'
import { err, ok, type Result } from '@tbe/shared-kernel'
import { baseOf, type Booking, type BookingBase, type BookingIn } from './booking.js'
import type { CommandOf, CommandType, TargetOf } from './commands.js'
import { BookingRuleError, type BookingRule } from './errors.js'
import type { BookingChange } from './events.js'
import { isSameAmount } from './price.js'
import { scheduleFor } from './refund-schedule.js'

/**
 * Satu fungsi untuk setiap perintah. Masing-masing hanya memeriksa ATURAN
 * perintahnya; apakah perintah itu boleh dijalankan pada keadaan sekarang
 * diputuskan tabel di transitions.ts, bukan di sini. Tidak ada satu pun
 * `if (booking.status !== ...)` di berkas ini, dan itu disengaja: pemeriksaan
 * keadaan yang tersebar di handler adalah persis "percabangan tersebar" yang
 * ingin digantikan tabel.
 *
 * Tipe [Handler] mengikat keduanya. Handler `hold` menerima pemesanan berkeadaan
 * tempat ia dipasang di tabel, dan WAJIB mengembalikan keadaan yang dinyatakan
 * COMMAND_TARGETS — mengembalikan keadaan lain adalah galat compiler.
 *
 * Parameter pertamanya tipe pemesanan itu sendiri, bukan nama keadaannya.
 * Versi pertama menulis `Handler<S extends BookingStatus, ...>` dengan
 * `BookingIn<S>` di dalamnya, dan compiler menolak handler yang menerima DUA
 * keadaan dipasang pada baris salah satunya: `BookingIn` adalah tipe
 * kondisional, dan varians parameter di dalam tipe kondisional diukur sebagai
 * kovarian — terbalik dari yang benar untuk posisi parameter fungsi.
 */

export type Handler<B extends Booking, C extends CommandType> = (
  booking: B,
  command: CommandOf<C>,
) => Result<BookingChange<BookingIn<TargetOf<C>>>, BookingRuleError>

/** Bidang dasar keadaan berikutnya: versi naik satu, waktu ubah = waktu kejadian. */
export function next(booking: Booking, at: Date): BookingBase {
  return { ...baseOf(booking), version: booking.version + 1, updatedAt: at }
}

export function meta(base: BookingBase) {
  return { bookingId: base.id, version: base.version, occurredAt: base.updatedAt }
}

export function violation(booking: Booking, rule: BookingRule, message: string) {
  return err(new BookingRuleError(booking.id, rule, message))
}

export function isBlank(value: string): boolean {
  return value.trim().length === 0
}

/**
 * Kebijakan pembatalan yang dijawab supplier pada price check ini (Step 25)
 * MENGGANTIKAN yang dikirim peramban, dan jadwal pengembaliannya disimpan.
 *
 * Ketentuan tawaran tetap salinan dari hasil pencarian untuk nama kamar dan
 * rate plan — yang tidak mengubah uang siapa pun. Kebijakan pembatalan
 * mengubahnya, jadi hanya versi supplier yang dipercaya; voucher pun mencetak
 * versi itu.
 */
function withVerifiedPolicy(base: BookingBase, command: CommandOf<'verifyPrice'>): BookingBase {
  const refundSchedule = scheduleFor(command.policy)
  const terms =
    base.terms === undefined ? {} : { terms: { ...base.terms, cancellationPolicy: command.policy } }

  return { ...base, ...terms, refundSchedule }
}

export const verifyPrice: Handler<BookingIn<'DRAFT' | 'PRICE_CHECKED'>, 'verifyPrice'> = (
  booking,
  command,
) => {
  // Price check ulang saat perubahan harga menunggu persetujuan akan
  // membandingkan harga supplier dengan harga lama yang sudah ditinggalkan, dan
  // hasil "sama" darinya memutar alur kembali tanpa pernah menerbitkan
  // peristiwa yang mengabarkan payment-service bahwa nilainya kembali ke semula.
  if (booking.status === 'PRICE_CHECKED' && booking.priceCheck.kind === 'changed') {
    return violation(booking, 'price_awaiting_approval', 'Perubahan harga belum disetujui')
  }

  const base = withVerifiedPolicy(next(booking, command.at), command)
  const agreed = booking.price.total
  const schedule = { refundTiers: scheduleFor(command.policy).tiers }

  if (isSameAmount(command.verified.total, agreed)) {
    // Rincian yang terverifikasi MENGGANTIKAN rincian yang disetujui, karena
    // totalnya sama: nilai yang boleh ditagih tidak berubah (G2), hanya
    // susunannya yang kini datang dari supplier dan pricing-service. Versi
    // Step 16 mempertahankan rincian lama, dan Step 17 menemukan akibatnya:
    // harga yang ditampilkan hanya punya satu baris, jadi e-voucher (FR-24)
    // akan terbit tanpa baris pajak.
    return ok({
      booking: {
        ...base,
        price: command.verified,
        status: 'PRICE_CHECKED',
        priceCheck: { kind: 'verified' },
      },
      event: { type: 'PriceVerified', ...meta(base), amount: agreed, ...schedule },
    })
  }

  return ok({
    booking: {
      ...base,
      status: 'PRICE_CHECKED',
      priceCheck: { kind: 'changed', quoted: command.verified },
    },
    event: {
      type: 'PriceChanged',
      ...meta(base),
      previousAmount: agreed,
      newAmount: command.verified.total,
      ...schedule,
    },
  })
}

export const acceptPrice: Handler<BookingIn<'PRICE_CHECKED'>, 'acceptPrice'> = (
  booking,
  command,
) => {
  const check = booking.priceCheck
  if (check.kind !== 'changed') {
    return violation(booking, 'no_price_change', 'Tidak ada perubahan harga untuk disetujui')
  }

  // Harga yang disetujui berpindah ke harga baru, tetapi keadaannya `accepted`,
  // bukan `verified`: hold masih menuntut price check berikutnya.
  const base = { ...next(booking, command.at), price: check.quoted }

  return ok({
    booking: { ...base, status: 'PRICE_CHECKED', priceCheck: { kind: 'accepted' } },
    event: { type: 'PriceAccepted', ...meta(base), amount: check.quoted.total },
  })
}

export const hold: Handler<BookingIn<'PRICE_CHECKED'>, 'hold'> = (booking, command) => {
  const kind = booking.priceCheck.kind
  if (kind === 'changed') {
    return violation(booking, 'price_awaiting_approval', 'Perubahan harga belum disetujui')
  }
  if (kind === 'accepted') {
    return violation(booking, 'price_not_reverified', 'Harga yang disetujui belum diverifikasi')
  }
  if (isBlank(command.holdRef)) {
    return violation(booking, 'blank_field', 'Token hold supplier kosong')
  }
  if (command.heldUntil.getTime() <= command.at.getTime()) {
    return violation(booking, 'hold_window_invalid', 'Batas waktu hold sudah lewat')
  }

  const base = next(booking, command.at)
  const held = { holdRef: command.holdRef, heldUntil: command.heldUntil }

  return ok({
    booking: { ...base, status: 'HELD', ...held },
    event: { type: 'BookingHeld', ...meta(base), ...held },
  })
}

export const expireHold: Handler<BookingIn<'HELD'>, 'expireHold'> = (booking, command) => {
  // Kedaluwarsa lebih awal adalah bug yang paling mahal di jalur ini: pengguna
  // yang sedang membayar kehilangan kamarnya. Penyapu berkala Step 17 memanggil
  // ini dengan jamnya sendiri, dan jam antar mesin tidak pernah persis sama.
  if (command.at.getTime() < booking.heldUntil.getTime()) {
    return violation(booking, 'hold_not_expired', 'Hold belum melewati batas waktunya')
  }

  const base = next(booking, command.at)
  const held = { holdRef: booking.holdRef, heldUntil: booking.heldUntil }

  return ok({
    booking: { ...base, status: 'EXPIRED', ...held },
    event: { type: 'HoldExpired', ...meta(base), ...held },
  })
}

/**
 * Pembayaran diterima.
 *
 * SENGAJA tidak menolak pembayaran yang tiba setelah `heldUntil`. Uangnya sudah
 * berpindah; menolaknya di sini tidak mengembalikannya, hanya membuat
 * pembayaran berhasil tanpa pemesanan yang mengakuinya — persis yang dilarang
 * Step 19. Selama pemesanan masih HELD, pembayaran diterima; bila sudah
 * EXPIRED, tabel transisi yang menolaknya, dan saga Step 19 yang memutuskan
 * refund.
 */
export const recordPayment: Handler<BookingIn<'HELD'>, 'recordPayment'> = (booking, command) => {
  if (isBlank(command.paymentId)) {
    return violation(booking, 'blank_field', 'Pengenal pembayaran kosong')
  }
  if (!isSameAmount(command.amount, booking.price.total)) {
    return violation(booking, 'amount_mismatch', 'Nilai pembayaran berbeda dari harga disetujui')
  }

  const base = next(booking, command.at)

  return ok({
    booking: { ...base, status: 'PAID', paymentId: command.paymentId },
    event: {
      type: 'PaymentRecorded',
      ...meta(base),
      paymentId: command.paymentId,
      amount: command.amount,
    },
  })
}

export const confirm: Handler<BookingIn<'PAID'>, 'confirm'> = (booking, command) => {
  if (isBlank(command.supplierRef)) {
    return violation(booking, 'blank_field', 'Booking reference supplier kosong')
  }

  const base = next(booking, command.at)

  return ok({
    booking: {
      ...base,
      status: 'CONFIRMED',
      paymentId: booking.paymentId,
      supplierRef: command.supplierRef,
    },
    event: {
      type: 'BookingConfirmed',
      ...meta(base),
      supplier: booking.supplier,
      supplierRef: command.supplierRef,
    },
  })
}

export const fail: Handler<BookingIn<'PAID'>, 'fail'> = (booking, command) => {
  if (isBlank(command.reason)) return violation(booking, 'blank_field', 'Alasan kegagalan kosong')

  const base = next(booking, command.at)

  return ok({
    booking: {
      ...base,
      status: 'FAILED',
      paymentId: booking.paymentId,
      failure: { reason: command.reason },
    },
    event: {
      type: 'BookingFailed',
      ...meta(base),
      paymentId: booking.paymentId,
      reason: command.reason,
    },
  })
}

/**
 * Refund tuntas. Nilainya wajib sama dengan harga yang ditagih: REFUNDED adalah
 * klaim bahwa SELURUH uang pengguna sudah kembali, dan refund sebagian yang
 * tercatat sebagai REFUNDED menutup kasus yang sebenarnya masih berutang.
 * Refund sebagian bukan akhir yang sah di sini — ia jalan ke NEEDS_REVIEW.
 */
export const recordRefund: Handler<BookingIn<'FAILED'>, 'recordRefund'> = (booking, command) => {
  if (isBlank(command.refundId)) return violation(booking, 'blank_field', 'Pengenal refund kosong')
  if (!isSameAmount(command.amount, booking.price.total)) {
    return violation(booking, 'amount_mismatch', 'Nilai refund berbeda dari nilai yang ditagih')
  }

  const base = next(booking, command.at)

  return ok({
    booking: {
      ...base,
      status: 'REFUNDED',
      paymentId: booking.paymentId,
      failure: booking.failure,
      refundId: command.refundId,
    },
    event: {
      type: 'BookingRefunded',
      ...meta(base),
      paymentId: booking.paymentId,
      refundId: command.refundId,
      amount: command.amount,
    },
  })
}

/**
 * Pembatalan sebelum uang berpindah.
 *
 * Menerima pemesanan pada keadaan APA PUN menurut tipenya, karena ia memang
 * tidak membutuhkan bidang khas keadaan mana pun. Akibatnya compiler tidak
 * akan menolak bila `cancel` dipasang pada keadaan final di tabel — yang
 * menolaknya adalah uji dua arah di transitions.test.ts. Suntikan S2 di step
 * doc membuktikannya.
 */
export const cancel: Handler<Booking, 'cancel'> = (booking, command) => {
  const base = next(booking, command.at)

  return ok({
    booking: { ...base, status: 'CANCELLED', cancellation: command.reason },
    event: { type: 'BookingCancelled', ...meta(base), reason: command.reason },
  })
}

/**
 * Alasan peninjauan, dilengkapi yang dibutuhkan peninjau pembatalan (Step 25).
 *
 * NEEDS_REVIEW hanya membawa pembayaran. Pembatalan yang berhenti di tengah
 * jalan kehilangan booking reference yang mungkin sudah dibatalkan dan nilai
 * yang sudah disetujui pengguna — dua hal pertama yang harus diperiksa
 * manusia. Keduanya ditulis ke alasannya, bukan diserahkan ke jejak audit.
 */
function reviewReason(
  booking: BookingIn<'PAID' | 'FAILED' | 'CANCELLING'>,
  reason: string,
): string {
  if (booking.status !== 'CANCELLING') return reason

  const request = booking.cancellationRequest

  return (
    `${reason} (booking reference ${booking.supplierRef}; pengembalian disetujui ` +
    `${format(request.refund)}, ${String(request.percent)}%)`
  )
}

export const requireReview: Handler<
  BookingIn<'PAID' | 'FAILED' | 'CANCELLING'>,
  'requireReview'
> = (booking, command) => {
  if (isBlank(command.reason)) return violation(booking, 'blank_field', 'Alasan peninjauan kosong')

  const base = next(booking, command.at)
  const review = { from: booking.status, reason: reviewReason(booking, command.reason) }

  return ok({
    booking: { ...base, status: 'NEEDS_REVIEW', paymentId: booking.paymentId, review },
    event: { type: 'ReviewRequired', ...meta(base), paymentId: booking.paymentId, ...review },
  })
}
