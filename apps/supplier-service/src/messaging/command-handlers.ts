import type { CommandPayload } from '@tbe/event-contracts'
import type { DeadLetterContext } from '@tbe/messaging'
import type { Logger } from '@tbe/shared-kernel'
import { confirmBooking } from '../application/confirm-booking.js'
import type { ConfirmReplies, ResilienceDeps } from '../application/ports.js'
import { cancel } from '../application/supplier-operations.js'

/**
 * Penangan perintah dari RabbitMQ.
 *
 * Keduanya memanggil use case yang SAMA dengan rute HTTP. Tidak ada logika
 * bisnis di berkas ini — kalau ada, dua jalur masuk ke sistem akan berperilaku
 * berbeda, dan perbedaannya baru ketahuan saat salah satu jalur dipakai
 * sungguhan di produksi.
 *
 * Yang berbeda hanya cara melaporkan hasil: HTTP membalas pemanggil, sedangkan
 * di sini kegagalan yang layak dicoba ulang dilempar supaya pembungkus
 * consumer mengarahkannya ke antrian tunda.
 */

export interface HandlerDeps {
  readonly resilience: ResilienceDeps
  readonly logger: Logger
}

export interface ConfirmHandlerDeps extends HandlerDeps {
  /** Jalan balik ke saga (Step 19). Tanpanya hasil konfirmasi hanya masuk log. */
  readonly replies: ConfirmReplies
}

/**
 * Penolakan SAH dari supplier atas konfirmasi — kamar habis, hold kedaluwarsa —
 * ATAU kepastian bahwa tidak ada pemesanan yang tersimpan: supplier yang
 * menolak koneksi di setiap percobaan (sejak Step 20, lihat confirm-booking.ts).
 * Keduanya sama bagi saga: tidak ada kamar, jadi dana dikembalikan.
 *
 * Kelas tersendiri, bukan `Error` biasa, karena kabar dead letter harus dapat
 * membedakan "supplier menjawab tidak" dari "sesuatu gagal di tengah jalan".
 * Hanya yang pertama boleh dikabarkan sebagai `rejected`. Yang kedua — Kafka
 * mati setelah `book` berhasil, misalnya — bisa saja meninggalkan pemesanan
 * yang sudah terbentuk, dan mengabarkannya sebagai penolakan membuat saga
 * mengembalikan dana untuk kamar yang tetap harus dibayar.
 *
 * Tetap `Error` biasa bagi kebijakan retry — bukan AppError 4xx — supaya
 * mengikuti jenjang Step 05: step doc 19 menyatakan kegagalan permanen setelah
 * percobaan habis, dan jawaban "hold kedaluwarsa" dari supplier yang sedang
 * pulih pernah berubah pada percobaan berikutnya.
 */
export class SupplierConfirmRejected extends Error {
  readonly kind: string

  constructor(kind: string) {
    super(`konfirmasi gagal: ${kind}`)
    this.kind = kind
  }
}

/**
 * `supplier.confirm` — mengubah hold menjadi pemesanan.
 *
 * Kunci idempotensi datang dari perintahnya dan TIDAK dibuat ulang di sini.
 * Perintah yang sama yang dikirim ulang RabbitMQ setelah kegagalan membawa
 * kunci yang sama, dan itulah yang membuat pengiriman ulang tidak menghasilkan
 * pemesanan kedua.
 *
 * Setiap hasil kini DIUMUMKAN ke saga, bukan hanya dicatat. Pengumuman gagal
 * berarti perintahnya dilempar dan dicoba ulang: `book` yang kedua kalinya
 * dengan kunci yang sama mengadopsi pemesanan yang pertama, dan jawabannya
 * diumumkan lagi.
 */
export function handleConfirm(deps: ConfirmHandlerDeps) {
  return async (payload: CommandPayload<'supplier.confirm'>): Promise<void> => {
    const outcome = await confirmBooking(deps.resilience, {
      supplier: payload.supplier,
      holdRef: payload.holdRef,
      guestName: payload.guestName,
      idempotencyKey: payload.idempotencyKey,
    })
    const subject = { bookingId: payload.bookingId, supplier: payload.supplier }

    if (outcome.status === 'confirmed') {
      const supplierRef = outcome.booking.bookingReference
      deps.logger.info(
        { ...subject, adopted: outcome.adopted, supplierRef },
        outcome.adopted
          ? 'pemesanan yang sudah ada diadopsi, tidak dibuat ganda'
          : 'pemesanan dikonfirmasi ke supplier',
      )
      await deps.replies.confirmed({ ...subject, supplierRef, adopted: outcome.adopted })
      return
    }

    if (outcome.status === 'uncertain') {
      // TIDAK dilempar. Melempar berarti RabbitMQ mengirim ulang perintahnya,
      // dan mengirim ulang `book` dalam keadaan tidak pasti adalah persis
      // yang harus dihindari. Saga yang memutuskan — dan saga menandainya
      // untuk peninjauan, tidak mengembalikan dana (US-05).
      deps.logger.error(
        { ...subject, idempotencyKey: outcome.idempotencyKey },
        'status pemesanan di supplier tidak dapat dipastikan, diserahkan ke saga',
      )
      await deps.replies.uncertain({
        ...subject,
        idempotencyKey: outcome.idempotencyKey,
        reason: outcome.error.kind,
      })
      return
    }

    deps.logger.warn({ ...subject, kind: outcome.error.kind }, 'konfirmasi ke supplier ditolak')

    // Jawaban yang sah tetapi bukan keberhasilan. Dilempar supaya mengikuti
    // jenjang percobaan; bila habis, kabar dead letter di bawah yang
    // mengumumkan penolakannya ke saga.
    throw new SupplierConfirmRejected(outcome.error.kind)
  }
}

/**
 * Kabar dead letter untuk `supplier.confirm`.
 *
 * Penolakan yang percobaannya habis diumumkan `rejected`, dan saga menjalankan
 * kompensasinya — refund (US-03). SELAIN itu diumumkan `uncertain`: perintah
 * yang mati karena galat lain mungkin sudah sempat menghasilkan pemesanan di
 * salah satu percobaannya, dan jawaban yang jujur untuk itu adalah "tidak
 * tahu" — yang saga tandai untuk peninjauan, bukan refund membabi buta.
 */
export function handleConfirmDeadLetter(deps: ConfirmHandlerDeps) {
  return async (context: DeadLetterContext<'supplier.confirm'>): Promise<void> => {
    const { payload, error } = context
    const subject = { bookingId: payload.bookingId, supplier: payload.supplier }

    if (error instanceof SupplierConfirmRejected) {
      await deps.replies.rejected({ ...subject, reason: error.kind })
      return
    }

    deps.logger.error(
      { ...subject, err: error, reason: context.reason },
      'konfirmasi berhenti tanpa jawaban supplier yang pasti, diumumkan sebagai tidak pasti',
    )
    await deps.replies.uncertain({
      ...subject,
      idempotencyKey: payload.idempotencyKey,
      reason: `dead_letter:${context.reason}`,
    })
  }
}

/** `supplier.cancel` — membatalkan pemesanan sebagai kompensasi saga. */
export function handleCancel(deps: HandlerDeps) {
  return async (payload: CommandPayload<'supplier.cancel'>): Promise<void> => {
    const result = await cancel(deps.resilience, payload.supplier, payload.supplierRef)

    if (result.ok) {
      deps.logger.info(
        { bookingId: payload.bookingId, supplier: payload.supplier },
        'pemesanan dibatalkan di supplier',
      )
      return
    }

    if (result.error.kind === 'already_cancelled' || result.error.kind === 'not_found') {
      // Sudah dibatalkan berarti tujuannya tercapai. Melemparnya akan membuat
      // kompensasi diulang tanpa henti untuk sesuatu yang sudah selesai.
      deps.logger.info(
        { bookingId: payload.bookingId, kind: result.error.kind },
        'pembatalan sudah terjadi sebelumnya',
      )
      return
    }

    throw new Error(`pembatalan gagal: ${result.error.kind}`)
  }
}
