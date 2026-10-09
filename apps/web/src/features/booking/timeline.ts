import type { BookingStatus, BookingStatusView } from './types'

/**
 * Status pemesanan sebagai bahasa manusia (FR-23, FR-26, US-03).
 *
 * Fungsi murni dari jawaban `/bookings/:id/status` ke tahapan dan pesan.
 * Dipisahkan dari komponen supplier setiap keadaan — termasuk yang jarang —
 * dapat diuji satu per satu. Keadaan yang tidak punya kalimatnya sendiri
 * akan jatuh ke pesan generik, dan pesan generik setelah pembayaran adalah
 * persis yang dilarang step doc 21: pengguna harus tahu uangnya aman.
 *
 * Tidak ada kode galat internal di sini. `failureReason` dari server adalah
 * kalimat untuk operator, bukan untuk pengguna, dan sengaja tidak ditampilkan.
 */

export type StageState = 'done' | 'current' | 'pending' | 'stopped'

export interface Stage {
  readonly key: 'payment' | 'confirming' | 'confirmed' | 'voucher'
  readonly label: string
  readonly state: StageState
  readonly detail?: string
}

/**
 * Janji waktu yang ditampilkan untuk pemesanan yang ditinjau manusia.
 *
 * BELUM ditetapkan PRD; angka ini asumsi Step 21 dan dicatat di Temuan-nya
 * supaya dikonfirmasi pemilik proyek sebelum peluncuran.
 */
export const REVIEW_CONTACT_WITHIN = '1×24 jam'

export type OutcomeTone = 'success' | 'waiting' | 'refund' | 'review' | 'ended'

export interface Outcome {
  readonly tone: OutcomeTone
  readonly title: string
  readonly body: string
  /** Kalimat tentang uang pengguna. Selalu ada setelah pembayaran. */
  readonly money?: string
}

/** Pemesanan yang pernah terkonfirmasi lalu dibatalkan pengguna (Step 25). */
function wasConfirmed(view: BookingStatusView): boolean {
  return view.status === 'CONFIRMED' || view.cancellation !== null
}

export function stagesOf(view: BookingStatusView): readonly Stage[] {
  const paid =
    view.cancellation !== null ||
    !['DRAFT', 'PRICE_CHECKED', 'HELD', 'EXPIRED', 'CANCELLED'].includes(view.status)

  const payment: Stage = paid
    ? { key: 'payment', label: 'Pembayaran diterima', state: 'done' }
    : {
        key: 'payment',
        label: 'Menunggu pembayaran',
        state: view.status === 'HELD' ? 'current' : 'stopped',
        ...(view.status === 'HELD'
          ? { detail: 'Kami menunggu kabar dari penyedia pembayaran.' }
          : {}),
      }

  const confirming = confirmingStage(view, paid)
  const confirmed: Stage = {
    key: 'confirmed',
    label: 'Pemesanan dikonfirmasi',
    state: wasConfirmed(view) ? 'done' : 'pending',
    ...(view.supplierRef === null ? {} : { detail: `Kode pemesanan ${view.supplierRef}` }),
  }
  const voucher: Stage = {
    key: 'voucher',
    label: 'Voucher diterbitkan',
    state: view.status === 'CONFIRMED' ? 'current' : 'pending',
    ...(view.status === 'CONFIRMED' ? { detail: 'Sedang disiapkan dan dikirim ke surelmu.' } : {}),
  }

  return [payment, confirming, confirmed, voucher]
}

function confirmingStage(view: BookingStatusView, paid: boolean): Stage {
  const label = 'Mengonfirmasi ke penyedia'

  if (!paid) return { key: 'confirming', label, state: 'pending' }
  if (view.status === 'PAID') {
    return {
      key: 'confirming',
      label,
      state: 'current',
      detail: 'Biasanya selesai dalam satu menit.',
    }
  }
  if (wasConfirmed(view)) return { key: 'confirming', label, state: 'done' }

  return { key: 'confirming', label, state: 'stopped' }
}

const NOT_PAID: Outcome = {
  tone: 'ended',
  title: 'Pemesanan belum dibayar',
  body: 'Pemesanan ini belum sampai ke tahap pembayaran.',
}

/**
 * Satu kalimat per keadaan, sebagai tabel: tipe `Record` atas SELURUH status
 * membuat keadaan baru tanpa kalimatnya menjadi galat compiler.
 */
const OUTCOMES: Readonly<Record<BookingStatus, Outcome>> = {
  CONFIRMED: {
    tone: 'success',
    title: 'Pemesananmu terkonfirmasi',
    body: 'Penyedia sudah menyimpan kamarmu. Simpan kode pemesanan di bawah untuk check-in.',
  },
  PAID: {
    tone: 'waiting',
    title: 'Pembayaran diterima',
    body: 'Kami sedang mengonfirmasi kamarmu ke penyedia. Halaman ini akan berubah sendiri.',
    money: 'Uangmu aman. Bila penyedia tidak dapat mengonfirmasi, dana dikembalikan otomatis.',
  },
  HELD: {
    tone: 'waiting',
    title: 'Menunggu konfirmasi pembayaran',
    body: 'Bila kamu sudah membayar, kabarnya biasanya tiba dalam beberapa detik.',
  },
  FAILED: {
    tone: 'refund',
    title: 'Penyedia tidak dapat mengonfirmasi kamarmu',
    body: 'Pemesanan ini tidak dapat diselesaikan. Kamu tidak perlu melakukan apa pun.',
    money: 'Pengembalian dana sedang diproses ke metode pembayaran yang kamu pakai.',
  },
  REFUNDED: {
    tone: 'refund',
    title: 'Dana sudah dikembalikan',
    body: 'Penyedia tidak dapat mengonfirmasi kamarmu, jadi pembayarannya kami kembalikan.',
    money:
      'Pengembalian sudah dikirim. Waktu sampainya ke rekening bergantung pada bank atau penyedia kartumu.',
  },
  NEEDS_REVIEW: {
    tone: 'review',
    title: 'Pemesananmu sedang kami periksa',
    body: `Kami belum mendapat kepastian dari penyedia, jadi tim kami memeriksanya langsung. Kami menghubungimu lewat surel dalam ${REVIEW_CONTACT_WITHIN}.`,
    money:
      'Pembayaranmu tercatat dan aman. Bila kamar tidak dapat dipastikan, dana dikembalikan penuh.',
  },
  EXPIRED: {
    tone: 'ended',
    title: 'Waktu penahanan kamar habis',
    body: 'Kamar dilepas karena pembayaran belum diterima tepat waktu.',
    money: 'Bila pembayaranmu ternyata masuk setelahnya, dana dikembalikan otomatis.',
  },
  CANCELLED: {
    tone: 'ended',
    title: 'Pemesanan dibatalkan',
    body: 'Pembayaran tidak berhasil atau kamar tidak lagi tersedia.',
    money: 'Tidak ada dana yang ditagih untuk pemesanan ini.',
  },
  CANCELLING: {
    tone: 'waiting',
    title: 'Pembatalan sedang diproses',
    body: 'Kami sedang membatalkan kamarmu di penyedia. Halaman ini akan berubah sendiri.',
    money:
      'Dana yang kembali sesuai kebijakan pembatalan dikirim setelah penyedia membatalkan kamarnya.',
  },
  DRAFT: NOT_PAID,
  PRICE_CHECKED: NOT_PAID,
}

/**
 * Pembatalan oleh pengguna setelah terkonfirmasi (Step 25). CANCELLED yang
 * sama dengan pembatalan sebelum bayar akan berbohong di sini — "tidak ada
 * dana yang ditagih" untuk pemesanan yang sudah dibayar.
 */
function cancelledByUser(refundMinor: number): Outcome {
  return {
    tone: 'refund',
    title: 'Pemesanan dibatalkan',
    body: 'Pemesanan ini sudah dibatalkan sesuai permintaanmu.',
    money:
      refundMinor > 0
        ? 'Pengembalian dana sudah dikirim ke metode pembayaran yang kamu pakai.'
        : 'Sesuai kebijakan pembatalan rate plan ini, tidak ada dana yang dikembalikan.',
  }
}

const CANCELLATION_REVIEW: Outcome = {
  tone: 'review',
  title: 'Pembatalanmu sedang kami periksa',
  body: `Permintaan pembatalanmu sudah kami terima, tetapi penyelesaiannya tertunda. Kami menghubungimu lewat surel dalam ${REVIEW_CONTACT_WITHIN}.`,
  money:
    'Pembayaranmu tercatat dan aman. Dana yang menjadi hakmu sesuai kebijakan pembatalan tetap akan dikembalikan.',
}

export function outcomeOf(view: BookingStatusView): Outcome {
  if (view.status === 'CANCELLED' && view.cancellation !== null) {
    return cancelledByUser(view.cancellation.refund.amountMinor)
  }
  if (view.status === 'NEEDS_REVIEW' && view.review === 'cancellation') return CANCELLATION_REVIEW

  return OUTCOMES[view.status]
}
