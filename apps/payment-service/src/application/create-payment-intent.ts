import { equals, type Money } from '@tbe/money'
import { createPayment, type Payment } from '../domain/payment.js'
import type { PaymentDeps } from './ports.js'

/**
 * Pembuatan maksud pembayaran (FR-19).
 *
 * Satu keputusan yang menentukan seluruh bentuk berkas ini: **nilai yang
 * ditagih TIDAK diambil dari permintaan.** Ia diambil dari
 * [PayableAmounts] — catatan yang diturunkan dari peristiwa `booking.created`
 * dan `booking.price_changed`.
 *
 * Nilai pada permintaan tetap wajib, tetapi hanya sebagai PEMBANDING: ia
 * mewakili angka yang dilihat pengguna di halamannya. Kalau keduanya berbeda,
 * halaman itu sudah basi, dan yang benar adalah menghentikan alurnya — bukan
 * menagih salah satu dari keduanya. Itulah G2: pengguna tidak pernah dibebani
 * nilai selain yang terakhir disetujuinya.
 *
 * Pemesanan yang belum punya catatan harga DITOLAK, bukan ditagih sebesar nilai
 * permintaan. Menerimanya berarti nilai yang ditagih ditentukan oleh pihak yang
 * meminta pembayaran, dan seluruh penjagaan di atas menjadi hiasan.
 *
 * Service ini tidak pernah memanggil booking-service untuk menanyakannya —
 * Step 18 mewajibkan komunikasi lewat peristiwa. Consumer yang mengisi catatan
 * itu ada di messaging/booking-events.ts.
 */

export interface CreateIntentInput {
  readonly bookingId: string
  /** Kunci idempotensi permintaan (FR-18). Ditegakkan batasan UNIK. */
  readonly idempotencyKey: string
  /** Nilai yang DILIHAT pengguna. Dibandingkan, tidak ditagih. */
  readonly amount: Money
}

export type IntentRejection =
  'amount_not_approved' | 'amount_unknown' | 'gateway_rejected' | 'gateway_unavailable'

export type CreateIntentResult =
  | {
      readonly kind: 'created'
      readonly payment: Payment
      readonly redirectUrl: string
      /** Token Snap untuk mode popup. Sama dengan rujukan transaksi di penyedia. */
      readonly snapToken: string
    }
  /** Pembayaran yang sama, penagihannya diminta ulang. Permintaan berulang atau percobaan ulang. */
  | {
      readonly kind: 'resumed'
      readonly payment: Payment
      readonly redirectUrl: string
      readonly snapToken: string
    }
  /** Sudah tidak PENDING. Tidak ada yang perlu ditagih lagi. */
  | { readonly kind: 'existing'; readonly payment: Payment }
  | { readonly kind: 'rejected'; readonly why: IntentRejection }

export async function createPaymentIntent(
  deps: PaymentDeps,
  input: CreateIntentInput,
): Promise<CreateIntentResult> {
  const approved = await approvedAmount(deps, input)

  if (approved === undefined) return { kind: 'rejected', why: 'amount_unknown' }
  if (approved.kind === 'mismatch') return { kind: 'rejected', why: 'amount_not_approved' }

  const candidate = createPayment({
    id: deps.ids.next(),
    bookingId: input.bookingId,
    amount: approved.amount,
    idempotencyKey: input.idempotencyKey,
  })

  // Penyisipan LEBIH DULU, penyedia sesudahnya. Urutan sebaliknya berarti
  // transaksi sudah ada di penyedia ketika penyisipan ditolak batasan UNIK, dan
  // transaksi penyedia yang tidak punya baris di sisi kita adalah uang yang
  // tidak dapat dipertanggungjawabkan.
  const inserted = await deps.payments.insert(candidate)
  const payment = inserted.kind === 'inserted' ? candidate : inserted.existing

  if (payment.status !== 'PENDING') {
    // Menagih ulang pembayaran yang sudah berhasil adalah penagihan ganda, dan
    // menagih ulang yang sudah gagal membutuhkan maksud pembayaran baru —
    // dengan kunci idempotensi baru.
    deps.logger.info(
      { paymentId: payment.id, status: payment.status },
      'permintaan pembayaran diulang untuk pembayaran yang sudah selesai',
    )

    return { kind: 'existing', payment }
  }

  return await charge(deps, payment, inserted.kind === 'inserted')
}

type ApprovedAmount =
  { readonly kind: 'approved'; readonly amount: Money } | { readonly kind: 'mismatch' }

async function approvedAmount(
  deps: PaymentDeps,
  input: CreateIntentInput,
): Promise<ApprovedAmount | undefined> {
  const payable = await deps.payables.find(input.bookingId)

  if (payable === undefined) {
    deps.logger.warn(
      { bookingId: input.bookingId },
      'belum ada harga yang tercatat untuk pemesanan ini, pembayaran ditolak',
    )

    return undefined
  }

  if (!isSameMoney(payable.amount, input.amount)) {
    deps.logger.warn(
      {
        bookingId: input.bookingId,
        approvedMinor: payable.amount.amountMinor,
        requestedMinor: input.amount.amountMinor,
        currency: payable.amount.currency,
        source: payable.source,
      },
      'nilai permintaan berbeda dari harga yang disetujui pengguna, pembayaran dihentikan',
    )

    return { kind: 'mismatch' }
  }

  return { kind: 'approved', amount: payable.amount }
}

/**
 * Kesetaraan nilai uang, lewat @tbe/money — bukan perbandingan dua bidang
 * dengan tangan.
 *
 * Alasannya muncul dari uji suntikan S11: mengganti `payable.amount` dengan
 * `input.amount` pada nilai yang ditagih TIDAK menggagalkan satu pun uji, karena
 * perbandingan di atas sudah menjamin keduanya sama di titik itu. Artinya seluruh
 * jaminan G2 bertumpu pada perbandingan ini sendirian.
 *
 * Perbandingan dua bidang dengan tangan akan diam-diam berhenti lengkap begitu
 * `Money` bertambah bidang. `equals` dari package uang itu ikut berubah bersama
 * tipenya, dan pemeriksaan mata uang mendahuluinya karena `equals` MELEMPAR untuk
 * mata uang yang berbeda — dan mata uang berbeda di sini adalah data yang salah
 * dari luar, bukan cacat program.
 */
function isSameMoney(approved: Money, requested: Money): boolean {
  return approved.currency === requested.currency && equals(approved, requested)
}

/**
 * Meminta transaksi ke penyedia.
 *
 * `paymentId` menjadi `order_id` di sisi penyedia, dan itu membuat penagihan
 * idempoten terhadap pembayaran yang sama: permintaan ulang memakai order_id
 * yang sama, jadi tidak ada transaksi kedua yang terbentuk di sana. Tanpa itu,
 * pembayaran yang penyedianya sempat tidak dapat dihubungi akan terkunci
 * selamanya oleh kunci idempotensinya sendiri.
 */
async function charge(
  deps: PaymentDeps,
  payment: Payment,
  isNew: boolean,
): Promise<CreateIntentResult> {
  const result = await deps.gateway.charge({
    paymentId: payment.id,
    bookingId: payment.bookingId,
    amount: payment.amount,
  })

  if (result.kind === 'created') {
    const link = { redirectUrl: result.redirectUrl, snapToken: result.providerRef }
    return isNew ? { kind: 'created', payment, ...link } : { kind: 'resumed', payment, ...link }
  }

  if (result.kind === 'rejected') {
    // Baris pembayaran TIDAK dihapus. Menghapusnya membebaskan kunci
    // idempotensinya, dan permintaan ulang akan membuat baris kedua untuk
    // pemesanan yang sama.
    deps.logger.warn(
      { paymentId: payment.id, reason: result.reason },
      'penyedia menolak permintaan pembayaran',
    )

    return { kind: 'rejected', why: 'gateway_rejected' }
  }

  deps.logger.error(
    { paymentId: payment.id },
    'penyedia pembayaran tidak dapat dihubungi, permintaan dapat diulang dengan kunci yang sama',
  )

  return { kind: 'rejected', why: 'gateway_unavailable' }
}
