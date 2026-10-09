import { AppError } from '@tbe/shared-kernel'

/**
 * Galat yang menentukan nasib perintah `voucher.generate`.
 *
 * Pembungkus consumer @tbe/messaging membaca status HTTP galat untuk memilih
 * antara antrian tunda dan dead letter: 5xx dicoba lagi berjenjang, 4xx
 * langsung ke dead letter.
 */

/**
 * Penolakan yang tidak akan berubah dengan dicoba lagi: pemesanannya tidak
 * ada, belum CONFIRMED, tanpa booking reference, atau propertinya tidak
 * dikenal katalog. Perintah ini tidak seharusnya pernah dikirim — saga hanya
 * mengirimnya sesudah konfirmasi — jadi kedatangannya butuh manusia.
 */
export class VoucherRefusedError extends AppError {
  constructor(bookingId: string, reason: string) {
    super({
      code: 'VOUCHER_REFUSED',
      httpStatus: 409,
      message: `Voucher untuk pemesanan ${bookingId} tidak dapat diterbitkan: ${reason}`,
      details: { bookingId, reason },
    })
  }
}

/**
 * Properti pemesanan belum dikenal katalog. Sementara, bukan final: operator
 * dapat memetakannya, dan snapshot katalog yang baru dimuat ulang juga
 * menjawab 404 sampai selesai. 503 membuatnya masuk antrian tunda berjenjang.
 */
export class PropertyUnmappedError extends AppError {
  constructor(bookingId: string) {
    super({
      code: 'PROPERTY_UNMAPPED',
      httpStatus: 503,
      message: `Properti pemesanan ${bookingId} belum terpetakan di katalog`,
      details: { bookingId },
    })
  }
}
