import type { CommandPayload } from '@tbe/event-contracts'
import type { Logger } from '@tbe/shared-kernel'
import { confirmBooking } from '../application/confirm-booking.js'
import type { ResilienceDeps } from '../application/ports.js'
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

/**
 * `supplier.confirm` — mengubah hold menjadi pemesanan.
 *
 * Kunci idempotensi datang dari perintahnya dan TIDAK dibuat ulang di sini.
 * Perintah yang sama yang dikirim ulang RabbitMQ setelah kegagalan membawa
 * kunci yang sama, dan itulah yang membuat pengiriman ulang tidak menghasilkan
 * pemesanan kedua.
 */
export function handleConfirm(deps: HandlerDeps) {
  return async (payload: CommandPayload<'supplier.confirm'>): Promise<void> => {
    const outcome = await confirmBooking(deps.resilience, {
      supplier: payload.supplier,
      holdRef: payload.holdRef,
      guestName: payload.guestName,
      idempotencyKey: payload.idempotencyKey,
    })

    if (outcome.status === 'confirmed') {
      deps.logger.info(
        {
          bookingId: payload.bookingId,
          supplier: payload.supplier,
          adopted: outcome.adopted,
          supplierRef: outcome.booking.bookingReference,
        },
        outcome.adopted
          ? 'pemesanan yang sudah ada diadopsi, tidak dibuat ganda'
          : 'pemesanan dikonfirmasi ke supplier',
      )
      return
    }

    if (outcome.status === 'uncertain') {
      // TIDAK dilempar. Melempar berarti RabbitMQ mengirim ulang perintahnya,
      // dan mengirim ulang `book` dalam keadaan tidak pasti adalah persis
      // yang harus dihindari. Rekonsiliasi Step 28 yang menuntaskannya.
      deps.logger.error(
        {
          bookingId: payload.bookingId,
          supplier: payload.supplier,
          idempotencyKey: outcome.idempotencyKey,
        },
        'status pemesanan di supplier tidak dapat dipastikan, diserahkan ke rekonsiliasi',
      )
      return
    }

    deps.logger.warn(
      { bookingId: payload.bookingId, supplier: payload.supplier, kind: outcome.error.kind },
      'konfirmasi ke supplier ditolak',
    )

    // Jawaban yang sah tetapi bukan keberhasilan — kamar habis, hold
    // kedaluwarsa. Dilempar supaya saga menjalankan kompensasinya.
    throw new Error(`konfirmasi gagal: ${outcome.error.kind}`)
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
