import type { CommandPayload } from '@tbe/event-contracts'
import { issueVoucher, type IssueRefusal } from '../application/issue-voucher.js'
import type { VoucherDeps } from '../application/ports.js'
import { PropertyUnmappedError, VoucherRefusedError } from '../domain/errors.js'

/**
 * Penangan perintah `voucher.generate` dari RabbitMQ.
 *
 * Tidak ada logika bisnis di sini — seluruhnya di application/issue-voucher.ts.
 * Yang diputuskan di berkas ini hanya apa yang DILEMPAR, karena pembungkus
 * consumer @tbe/messaging membacanya untuk memilih jalur:
 *
 * - terbit, atau sudah pernah terbit → tidak dilempar; perintah di-ack.
 * - penolakan → `VoucherRefusedError` (409): langsung ke dead letter. Mencoba
 *   lagi tidak akan membuat pemesanan yang belum terkonfirmasi menjadi
 *   terkonfirmasi.
 * - properti belum terpetakan → `PropertyUnmappedError` (503): dicoba lagi,
 *   karena keadaan itu dapat berubah tanpa ada yang mengirim ulang perintah.
 * - booking-service, katalog, MinIO, Postgres, atau Kafka tidak dapat
 *   dihubungi → galat dari adapter diteruskan apa adanya (5xx atau galat yang
 *   tidak dikenal): antrian tunda berjenjang 5 detik, 30 detik, 2 menit, lalu
 *   dead letter. Jenjang pertama yang 5 detik itulah yang menjaga M7 (< 30
 *   detik) tetap tercapai ketika satu dependensi tersendat sesaat.
 */

export function handleGenerate(deps: VoucherDeps) {
  return async (payload: CommandPayload<'voucher.generate'>): Promise<void> => {
    const result = await issueVoucher(deps, payload.bookingId)

    if (result.kind !== 'refused') return

    // Properti yang belum terpetakan BISA berubah: operator memetakannya dari
    // antrian, atau snapshot katalog search-service baru selesai dimuat
    // sesudah restart. Pemesanan ini sudah dibayar dan terkonfirmasi, jadi
    // ia dicoba lagi sepanjang jenjang tunda sebelum menyerah ke dead letter.
    if (result.refusal.kind === 'property_unmapped') {
      throw new PropertyUnmappedError(payload.bookingId)
    }

    throw new VoucherRefusedError(payload.bookingId, refusalText(result.refusal))
  }
}

export function refusalText(refusal: IssueRefusal): string {
  switch (refusal.kind) {
    case 'booking_not_found':
      return 'pemesanan tidak ditemukan'
    case 'property_unmapped':
      return 'properti belum terpetakan di katalog'
    case 'not_confirmed':
      return `pemesanan belum CONFIRMED (status ${refusal.status})`
    case 'missing_reference':
      return 'booking reference supplier tidak ada'
  }
}
