import type { CommandPayload } from '@tbe/event-contracts'
import type { DeadLetterContext } from '@tbe/messaging'
import type { Logger } from '@tbe/shared-kernel'
import { confirmBooking } from '../application/confirm-booking.js'
import type { CancelReplies, ConfirmReplies, ResilienceDeps } from '../application/ports.js'
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

export interface CancelHandlerDeps extends HandlerDeps {
  /** Jalan balik ke saga pembatalan (Step 25). */
  readonly cancelReplies: CancelReplies
}

/**
 * `supplier.cancel` — membatalkan pemesanan: kompensasi saga pemesanan, atau
 * langkah pertama pembatalan oleh pengguna (Step 25).
 *
 * Hasilnya kini DIUMUMKAN. Pembatalan oleh pengguna tidak mengembalikan dana
 * sebelum supplier memastikan kamarnya lepas, dan tanpa pengumuman ini saga
 * hanya dapat menunggu sampai batas waktunya lewat.
 */
export function handleCancel(deps: CancelHandlerDeps) {
  return async (payload: CommandPayload<'supplier.cancel'>): Promise<void> => {
    const result = await cancel(deps.resilience, payload.supplier, payload.supplierRef)
    const subject = {
      bookingId: payload.bookingId,
      supplier: payload.supplier,
      supplierRef: payload.supplierRef,
    }

    if (result.ok) {
      deps.logger.info(subject, 'pemesanan dibatalkan di supplier')
      await deps.cancelReplies.cancelled(subject)
      return
    }

    if (result.error.kind === 'already_cancelled' || result.error.kind === 'not_found') {
      // Sudah dibatalkan berarti tujuannya tercapai. Melemparnya akan membuat
      // kompensasi diulang tanpa henti untuk sesuatu yang sudah selesai. Tidak
      // ditemukan juga berarti tidak ada kamar yang tertahan.
      deps.logger.info(
        { ...subject, kind: result.error.kind },
        'pembatalan sudah terjadi sebelumnya',
      )
      await deps.cancelReplies.cancelled(subject)
      return
    }

    // Penolakan 4xx adalah JAWABAN supplier: kamar ini tidak dibatalkan.
    // Selain itu — batas waktu, 5xx, jawaban rusak — pembatalannya mungkin
    // sudah terjadi dan hanya jawabannya yang hilang.
    if (result.error.kind === 'upstream_error' && result.error.status < 500) {
      throw new SupplierCancelRefused(`${result.error.kind}:${String(result.error.status)}`)
    }

    throw new Error(`pembatalan gagal: ${result.error.kind}`)
  }
}

/**
 * Supplier menjawab TIDAK atas pembatalan (Step 25). Tetap mengikuti jenjang
 * percobaan — jawaban yang sama dari supplier yang sedang pulih bisa berubah —
 * dan bila habis, diumumkan `refused`: kamar pasti masih terpesan.
 */
export class SupplierCancelRefused extends Error {
  readonly kind: string

  constructor(kind: string) {
    super(`pembatalan ditolak supplier: ${kind}`)
    this.kind = kind
  }
}

/**
 * Kabar dead letter untuk `supplier.cancel`: seluruh percobaan habis tanpa
 * kepastian kamarnya lepas. Diumumkan GAGAL, dan saga pembatalan tidak
 * mengembalikan dana — kamar yang masih terpesan ditambah uang yang sudah
 * kembali adalah kerugian ganda.
 *
 * `refused` hanya bila supplier sendiri yang menolak. Selain itu `uncertain`:
 * perintah yang mati karena batas waktu, galat server, atau Kafka yang mati
 * SETELAH pembatalan berhasil mungkin sudah melepas kamarnya.
 */
export function handleCancelDeadLetter(deps: CancelHandlerDeps) {
  return async (context: DeadLetterContext<'supplier.cancel'>): Promise<void> => {
    const { payload, error } = context
    const subject = {
      bookingId: payload.bookingId,
      supplier: payload.supplier,
      supplierRef: payload.supplierRef,
    }

    deps.logger.error(
      { ...subject, err: error, reason: context.reason },
      'pembatalan di supplier berhenti tanpa hasil, diumumkan gagal',
    )
    const refused = error instanceof SupplierCancelRefused
    await deps.cancelReplies.cancelFailed({
      ...subject,
      outcome: refused ? 'refused' : 'uncertain',
      reason: refused ? error.kind : `dead_letter:${context.reason}`,
    })
  }
}
