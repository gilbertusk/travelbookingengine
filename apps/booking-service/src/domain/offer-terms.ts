import { err, ok, type Result } from '@tbe/shared-kernel'

/**
 * Ketentuan tawaran yang dipesan: jenis kamar, nama rate plan, sarapan, dan
 * kebijakan pembatalan (Step 23).
 *
 * Disimpan sebagai SALINAN pada saat price check, bukan diambil ulang saat
 * voucher dibuat. Voucher adalah bukti atas apa yang dibeli; rate plan yang
 * sama bisa saja sudah hilang dari pencarian beberapa detik kemudian — justru
 * paling mungkin terjadi ketika kamar terakhir baru saja dipesan.
 *
 * Asalnya hasil pencarian yang dilihat pengguna, dikirim peramban bersama
 * pengenal rate plan — sama seperti `city`. Supplier tidak menjawab ulang
 * ketentuan ini saat price check (hanya totalnya), jadi yang dijamin di sini
 * hanyalah bentuknya. Harga TIDAK termasuk: harga selalu diverifikasi ke
 * supplier dan tidak pernah dipercaya dari peramban.
 */

export type CancellationPolicy =
  | { readonly refundable: false }
  | {
      readonly refundable: true
      /** Hari sebelum check-in ketika pembatalan masih gratis, bila supplier menyebutkannya. */
      readonly freeCancellationDays?: number
    }

export interface OfferTerms {
  readonly roomTypeName: string
  readonly ratePlanName: string
  readonly breakfastIncluded: boolean
  readonly cancellationPolicy: CancellationPolicy
}

/** Bentuk masukan: tenggat boleh hadir sebagai `undefined`, seperti keluaran Zod. */
export type CancellationPolicyInput =
  | { readonly refundable: false }
  | { readonly refundable: true; readonly freeCancellationDays?: number | undefined }

export interface OfferTermsInput {
  readonly roomTypeName: string
  readonly ratePlanName: string
  readonly breakfastIncluded: boolean
  readonly cancellationPolicy: CancellationPolicyInput
}

export type OfferTermsError =
  | { readonly kind: 'blank_name'; readonly field: 'roomTypeName' | 'ratePlanName' }
  | { readonly kind: 'name_too_long'; readonly field: 'roomTypeName' | 'ratePlanName' }
  | { readonly kind: 'invalid_free_cancellation_days' }

/** Nama yang lebih panjang dari ini bukan nama kamar, dan merusak tata letak voucher. */
export const MAX_TERM_NAME_LENGTH = 200

/** Tenggat pembatalan gratis lebih dari setahun sebelum menginap tidak masuk akal. */
export const MAX_FREE_CANCELLATION_DAYS = 365

const NAME_FIELDS = ['roomTypeName', 'ratePlanName'] as const

export function offerTerms(input: OfferTermsInput): Result<OfferTerms, OfferTermsError> {
  for (const field of NAME_FIELDS) {
    const value = input[field].trim()
    if (value.length === 0) return err({ kind: 'blank_name', field })
    if (value.length > MAX_TERM_NAME_LENGTH) return err({ kind: 'name_too_long', field })
  }

  const policy = input.cancellationPolicy
  if (policy.refundable && policy.freeCancellationDays !== undefined) {
    const days = policy.freeCancellationDays
    if (!Number.isInteger(days) || days < 0 || days > MAX_FREE_CANCELLATION_DAYS) {
      return err({ kind: 'invalid_free_cancellation_days' })
    }
  }

  return ok({
    roomTypeName: input.roomTypeName.trim(),
    ratePlanName: input.ratePlanName.trim(),
    breakfastIncluded: input.breakfastIncluded,
    cancellationPolicy: cancellationPolicyOf(policy),
  })
}

/** Salinan kebijakan tanpa bidang kosong — bentuk yang sama dari peramban maupun supplier. */
export function cancellationPolicyOf(policy: CancellationPolicyInput): CancellationPolicy {
  if (!policy.refundable) return { refundable: false }

  return policy.freeCancellationDays === undefined
    ? { refundable: true }
    : { refundable: true, freeCancellationDays: policy.freeCancellationDays }
}
