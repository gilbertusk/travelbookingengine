import { err, type Result } from '@tbe/shared-kernel'
import type { Booking, BookingIn, BookingStatus } from './booking.js'
import { COMMAND_TYPES, type BookingCommand, type CommandType } from './commands.js'
import { InvalidTransitionError, type BookingError, type BookingRuleError } from './errors.js'
import type { BookingChange } from './events.js'
import {
  acceptPrice,
  cancel,
  confirm,
  expireHold,
  fail,
  hold,
  recordPayment,
  recordRefund,
  requireReview,
  verifyPrice,
  type Handler,
} from './handlers.js'

/**
 * Tabel transisi, dinyatakan sebagai data.
 *
 * Baris adalah keadaan asal, kolom adalah perintah yang sah padanya. Keadaan
 * tujuannya ada di COMMAND_TARGETS (commands.ts). Pasangan yang TIDAK tercantum
 * di sini adalah transisi tidak sah, dan [applyCommand] mengembalikannya
 * sebagai [InvalidTransitionError] — tidak pernah diabaikan diam-diam.
 *
 *   DRAFT          ─verifyPrice→ PRICE_CHECKED   ─cancel→ CANCELLED
 *   PRICE_CHECKED  ─verifyPrice/acceptPrice→ PRICE_CHECKED
 *                  ─hold→ HELD                    ─cancel→ CANCELLED
 *   HELD           ─recordPayment→ PAID  ─expireHold→ EXPIRED  ─cancel→ CANCELLED
 *   PAID           ─confirm→ CONFIRMED   ─fail→ FAILED   ─requireReview→ NEEDS_REVIEW
 *   FAILED         ─recordRefund→ REFUNDED               ─requireReview→ NEEDS_REVIEW
 *
 * Beberapa sel yang layak dijelaskan, karena ketiadaannya disengaja:
 *
 * - **PAID tidak punya `cancel`.** Setelah uang diterima, pembatalan bukan
 *   perubahan keadaan melainkan kompensasi: refund harus berjalan dan berhasil
 *   lebih dulu. Jalannya lewat FAILED → REFUNDED. Membolehkan PAID → CANCELLED
 *   berarti pemesanan final dengan uang pengguna yang masih tertahan.
 * - **Kegagalan sebelum pembayaran berakhir di CANCELLED, bukan FAILED.** FAILED
 *   berarti "kompensasi uang sedang berjalan", dan jalan keluarnya hanya
 *   REFUNDED atau NEEDS_REVIEW. Pemesanan yang gagal sebelum ada uang tidak
 *   punya apa pun untuk dikembalikan, dan REFUNDED untuknya adalah catatan palsu.
 * - **HELD tidak punya `fail`.** Kegagalan pembayaran pada HELD adalah
 *   `cancel` dengan alasan `payment_failed` (Step 19: "pembayaran gagal setelah
 *   hold: hold terlepas, mencapai CANCELLED").
 * - **FAILED tidak punya `confirm`.** Konfirmasi supplier yang terlambat tiba
 *   setelah kompensasi dimulai adalah status supplier yang tidak dapat
 *   dipastikan, dan itu `requireReview` — US-05: refund membabi buta untuk
 *   pemesanan yang sebenarnya berhasil adalah kerugian jenis lain.
 * - **Kelima keadaan final tidak punya satu kolom pun.** CONFIRMED termasuk.
 *   Pembatalan setelah konfirmasi (FR-27, Step 25) belum dimodelkan di sini —
 *   lihat bagian Temuan di step doc.
 */
export const TRANSITIONS = {
  DRAFT: { verifyPrice, cancel },
  PRICE_CHECKED: { verifyPrice, acceptPrice, hold, cancel },
  HELD: { expireHold, recordPayment, cancel },
  PAID: { confirm, fail, requireReview },
  FAILED: { recordRefund, requireReview },
  CONFIRMED: {},
  REFUNDED: {},
  CANCELLED: {},
  EXPIRED: {},
  NEEDS_REVIEW: {},
} as const satisfies TransitionTable

/**
 * Bentuk tabel: pada baris keadaan S, handler untuk perintah C harus menerima
 * pemesanan berkeadaan S. Memasang `confirm` — yang membaca `paymentId` — pada
 * baris HELD adalah galat compiler, karena HELD tidak punya `paymentId`.
 */
export type TransitionTable = {
  readonly [S in BookingStatus]: { readonly [C in CommandType]?: Handler<BookingIn<S>, C> }
}

/** Perintah yang sah pada sebuah keadaan, sebagaimana dinyatakan tabel. */
export function allowedCommands(status: BookingStatus): readonly CommandType[] {
  const row: object = TRANSITIONS[status]

  return COMMAND_TYPES.filter((command) => command in row)
}

type AnyHandler = (
  booking: Booking,
  command: BookingCommand,
) => Result<BookingChange, BookingRuleError>

/**
 * Menjalankan satu perintah terhadap satu pemesanan.
 *
 * Tidak pernah melempar untuk kejadian yang dapat diantisipasi, dan tidak
 * pernah mengembalikan pemesanan yang tidak berubah sebagai "berhasil".
 * Perintah yang tidak ada di tabel untuk keadaan ini adalah galat, titik.
 * Pemanggil yang ingin idempotensi (peristiwa Kafka yang dikonsumsi dua kali)
 * mendapatkannya dari kunci versi di repository, bukan dari domain yang
 * pura-pura tidak mendengar.
 */
export function applyCommand(
  booking: Booking,
  command: BookingCommand,
): Result<BookingChange, BookingError> {
  const handler = handlerFor(booking.status, command.type)

  if (handler === undefined) {
    return err(new InvalidTransitionError(booking.id, booking.status, command.type))
  }

  return handler(booking, command)
}

function handlerFor(status: BookingStatus, command: CommandType): AnyHandler | undefined {
  // Satu-satunya type assertion di mesin keadaan ini, dan alasannya: TypeScript
  // tidak dapat menghubungkan `status` dengan baris tabel yang dipilihnya dan
  // `command.type` dengan kolomnya sekaligus (masalah "correlated union"). Yang
  // menjamin kecocokannya adalah tabel itu sendiri — baris dipilih DENGAN
  // status pemesanan, kolom DENGAN jenis perintah — dan tipe [TransitionTable]
  // yang memeriksa setiap sel saat tabel ditulis.
  const row = TRANSITIONS[status] as Readonly<Partial<Record<CommandType, AnyHandler>>>

  return row[command]
}
