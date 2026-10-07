import { voucherObjectKey } from '../domain/object-key.js'
import { composeVoucher, type ComposeRefusal } from '../domain/voucher-content.js'
import { issueLatencyMs, type Voucher, type VoucherSource } from '../domain/voucher.js'
import type { VoucherDeps } from './ports.js'

/**
 * Penerbitan voucher untuk satu pemesanan (FR-24, M7).
 *
 * **Idempoten terhadap bookingId.** RabbitMQ menjamin minimal sekali, saga
 * mengirim ulang perintah yang belum terjawab, dan dua consumer dapat menerima
 * perintah yang sama bersamaan. Ketiganya berakhir dengan SATU voucher:
 *
 * 1. Voucher yang sudah ada dikembalikan sebelum apa pun dikerjakan.
 * 2. Dua penerbitan yang berpacu sama-sama mengunggah PDF, tetapi hanya satu
 *    yang lolos batasan UNIK bookingId di basis data. Yang kalah menghapus
 *    berkasnya sendiri dan mengembalikan voucher pemenang.
 *
 * Basis data, bukan penyimpanan objek, yang memutuskan voucher mana yang sah:
 * berkas yatim di MinIO hanya pemborosan ruang, sedangkan dua baris voucher
 * untuk satu pemesanan adalah dua bukti yang bisa berbeda isinya.
 *
 * Peristiwa `voucher.issued` diterbitkan ulang juga untuk voucher yang sudah
 * ada. Perintah yang datang lagi bisa berarti percobaan sebelumnya mati sesudah
 * menyimpan tetapi sebelum mengumumkan; menerbitkan ulang dengan eventId yang
 * sama (id voucher) membuat pengumuman itu tidak pernah hilang, dan tetap dapat
 * dikenali sebagai duplikat oleh notification-service.
 */

export type IssueRefusal =
  { readonly kind: 'booking_not_found' } | { readonly kind: 'property_unmapped' } | ComposeRefusal

export type IssueResult =
  | { readonly kind: 'issued'; readonly voucher: Voucher }
  | { readonly kind: 'already_issued'; readonly voucher: Voucher }
  | { readonly kind: 'refused'; readonly refusal: IssueRefusal }

export async function issueVoucher(deps: VoucherDeps, bookingId: string): Promise<IssueResult> {
  const existing = await deps.vouchers.findByBookingId(bookingId)
  if (existing !== undefined) return await announceExisting(deps, existing)

  const lookup = await deps.bookings.voucherSource(bookingId)
  if (lookup.kind === 'not_found') return refused({ kind: 'booking_not_found' })

  const source = lookup.source
  const property = await deps.properties.bySupplier(source.supplier, source.supplierPropertyId)
  if (property === undefined) return refused({ kind: 'property_unmapped' })

  const issuedAt = deps.clock.now()
  const content = composeVoucher(source, property, issuedAt)
  if (!content.ok) return refused(content.error)

  const pdf = await deps.renderer.render(content.value)
  const voucher = newVoucher(deps, source, { issuedAt, sizeBytes: pdf.byteLength })

  await deps.storage.put(voucher.objectKey, pdf)

  return await record(deps, voucher)
}

function refused(refusal: IssueRefusal): IssueResult {
  return { kind: 'refused', refusal }
}

async function announceExisting(deps: VoucherDeps, voucher: Voucher): Promise<IssueResult> {
  await deps.events.issued(voucher, issueLatencyMs(voucher))

  return { kind: 'already_issued', voucher }
}

function newVoucher(
  deps: VoucherDeps,
  source: VoucherSource,
  file: { readonly issuedAt: Date; readonly sizeBytes: number },
): Voucher {
  return {
    id: deps.ids.next(),
    bookingId: source.bookingId,
    userId: source.userId,
    objectKey: voucherObjectKey(deps.tokens.next()),
    sizeBytes: file.sizeBytes,
    issuedAt: file.issuedAt,
    // composeVoucher sudah menolak pemesanan yang belum CONFIRMED, dan
    // booking-service selalu menyertakan confirmedAt pada CONFIRMED. Waktu
    // terbit sebagai cadangan membuat latensi tercatat nol, bukan negatif.
    confirmedAt: source.confirmedAt ?? file.issuedAt,
  }
}

async function record(deps: VoucherDeps, voucher: Voucher): Promise<IssueResult> {
  const outcome = await deps.vouchers.insert(voucher)

  if (outcome.kind === 'exists') {
    // Kalah berpacu: berkas kita tidak dirujuk baris mana pun. Gagal
    // menghapusnya tidak menggagalkan perintah — voucher pemenang sah, dan
    // berkas yatim hanya membuang ruang.
    await deps.storage.remove(voucher.objectKey).catch((error: unknown) => {
      deps.logger.warn(
        { err: error, bookingId: voucher.bookingId },
        'berkas voucher yang kalah berpacu gagal dihapus',
      )
    })
    return await announceExisting(deps, outcome.existing)
  }

  const latencyMs = issueLatencyMs(voucher)
  deps.metrics.observeIssueLatency(latencyMs / 1_000)
  await deps.events.issued(voucher, latencyMs)
  deps.logger.info(
    { bookingId: voucher.bookingId, voucherId: voucher.id, latencyMs },
    'voucher terbit',
  )

  return { kind: 'issued', voucher }
}
