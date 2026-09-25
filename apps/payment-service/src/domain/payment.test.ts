import { money } from '@tbe/money'
import { describe, expect, test } from 'vitest'
import {
  FINAL_STATUSES,
  PAYMENT_STATUSES,
  PROVIDER_OUTCOMES,
  TRANSITIONS,
  applyProviderOutcome,
  createPayment,
  isFinal,
  type Payment,
  type PaymentStatus,
  type ProviderOutcome,
} from './payment.js'

const AMOUNT = money(1_250_000, 'IDR')

function pending(): Payment {
  return createPayment({
    id: '11111111-1111-4111-8111-111111111111',
    bookingId: '22222222-2222-4222-8222-222222222222',
    amount: AMOUNT,
    idempotencyKey: 'bkg-1:attempt-1',
  })
}

/**
 * Pembayaran pada keadaan tertentu, dirakit lewat transisi yang sah — bukan
 * ditulis langsung sebagai objek literal.
 *
 * Membangun keadaan dengan tangan akan menghasilkan kombinasi yang tidak dapat
 * dicapai sistem sungguhan, dan uji yang lulus pada keadaan mustahil tidak
 * membuktikan apa pun tentang yang mungkin.
 */
function atStatus(status: PaymentStatus): Payment {
  switch (status) {
    case 'PENDING':
      return pending()
    case 'FAILED':
      return applied(pending(), 'FAILED')
    case 'SUCCEEDED':
      return applied(pending(), 'SUCCEEDED')
    case 'PARTIALLY_REFUNDED':
    case 'REFUNDED':
      return withRefundStatus(applied(pending(), 'SUCCEEDED'), status)
  }
}

function applied(payment: Payment, outcome: ProviderOutcome): Payment {
  const result = applyProviderOutcome(payment, {
    outcome,
    gatewayRef: 'midtrans-tx-1',
    amount: AMOUNT,
    reason: outcome === 'FAILED' ? 'deny' : undefined,
  })

  if (result.kind !== 'applied') throw new Error(`transisi ke ${outcome} seharusnya berlaku`)

  return result.payment
}

/**
 * Keadaan hasil refund dicapai lewat refund.ts pada berkas uji lain. Di sini
 * hanya statusnya yang dibutuhkan, jadi ia dibentuk dari keadaan SUCCEEDED —
 * yang sudah dicapai lewat transisi sah — dengan statusnya digantikan.
 */
function withRefundStatus(payment: Payment, status: 'PARTIALLY_REFUNDED' | 'REFUNDED'): Payment {
  if (payment.status !== 'SUCCEEDED') throw new Error('hanya dari SUCCEEDED')

  return { ...payment, status }
}

describe('pembuatan', () => {
  test('pembayaran baru berada pada PENDING dan belum punya rujukan penyedia', () => {
    const payment = pending()

    expect(payment.status).toBe('PENDING')
    // Bentuknya sendiri yang mencegah: gatewayRef tidak ada pada PENDING, jadi
    // tidak ada kode yang dapat membacanya tanpa mempersempit status lebih dulu.
    expect('gatewayRef' in payment).toBe(false)
  })
})

describe('tabel transisi', () => {
  test('setiap pasangan keadaan dan hasil penyedia punya keputusan', () => {
    for (const status of PAYMENT_STATUSES) {
      for (const outcome of PROVIDER_OUTCOMES) {
        expect(TRANSITIONS[status][outcome]).toBeDefined()
      }
    }
  })

  /**
   * Penjagaan utama NFR-06 di service ini: keadaan final tidak punya transisi
   * keluar. Notifikasi penyedia mana pun yang tiba pada keadaan final hanya
   * boleh berakhir sebagai tidak berubah atau tidak berurutan — tidak pernah
   * sebagai perubahan.
   */
  test('tidak ada notifikasi penyedia yang mengubah keadaan final', () => {
    for (const status of FINAL_STATUSES) {
      for (const outcome of PROVIDER_OUTCOMES) {
        expect(TRANSITIONS[status][outcome]).not.toBe('apply')
      }
    }
  })

  /**
   * Arah sebaliknya — bahwa setiap keadaan TIDAK final benar-benar punya
   * transisi keluar — tidak dapat dibuktikan dari tabel ini saja, dan percobaan
   * membuktikannya di sini yang menemukan alasannya: `SUCCEEDED` dan
   * `PARTIALLY_REFUNDED` tidak punya satu pun transisi keluar lewat notifikasi
   * penyedia. Transisi keluar keduanya datang dari REFUND, dan refund bukan
   * webhook.
   *
   * Menyimpulkan finalitas dari tabel ini saja akan menyatakan pembayaran
   * berhasil sebagai keadaan final padahal dana masih dapat dikembalikan —
   * persis kesalahan yang FINAL_STATUSES dibuat untuk mencegah. Buktinya
   * karena itu tinggal di refund.test.ts, satu-satunya tempat kedua tabel
   * terlihat sekaligus.
   */
  test('keadaan final tidak punya transisi keluar pada tabel notifikasi', () => {
    const frozenByProvider = PAYMENT_STATUSES.filter((status) =>
      PROVIDER_OUTCOMES.every((outcome) => TRANSITIONS[status][outcome] !== 'apply'),
    )

    expect(frozenByProvider).toEqual(expect.arrayContaining([...FINAL_STATUSES]))
  })

  test('isFinal sepakat dengan daftar keadaan final', () => {
    for (const status of PAYMENT_STATUSES) {
      expect(isFinal(status)).toBe(FINAL_STATUSES.includes(status))
    }
  })
})

describe('notifikasi pada pembayaran yang masih PENDING', () => {
  test('settlement membuat pembayaran SUCCEEDED beserta rujukan penyedianya', () => {
    const result = applyProviderOutcome(pending(), {
      outcome: 'SUCCEEDED',
      gatewayRef: 'midtrans-tx-9',
      amount: AMOUNT,
      reason: undefined,
    })

    expect(result.kind).toBe('applied')
    if (result.kind !== 'applied') return

    expect(result.payment.status).toBe('SUCCEEDED')
    if (result.payment.status !== 'SUCCEEDED') return

    expect(result.payment.gatewayRef).toBe('midtrans-tx-9')
    expect(result.payment.refunds).toEqual([])
  })

  test('penolakan membuat pembayaran FAILED beserta alasannya', () => {
    const result = applyProviderOutcome(pending(), {
      outcome: 'FAILED',
      gatewayRef: 'midtrans-tx-9',
      amount: AMOUNT,
      reason: 'deny',
    })

    expect(result.kind).toBe('applied')
    if (result.kind !== 'applied') return
    expect(result.payment.status).toBe('FAILED')
    if (result.payment.status !== 'FAILED') return
    expect(result.payment.failureReason).toBe('deny')
  })

  test('notifikasi pending tidak mengubah apa pun', () => {
    const before = pending()
    const result = applyProviderOutcome(before, {
      outcome: 'PENDING',
      gatewayRef: 'midtrans-tx-9',
      amount: AMOUNT,
      reason: undefined,
    })

    expect(result.kind).toBe('unchanged')
    expect(result.payment).toEqual(before)
  })
})

describe('notifikasi tidak berurutan', () => {
  /**
   * Inti dari Definisi Selesai "webhook tidak berurutan tidak merusak keadaan
   * final". Sandbox Midtrans mengirim notifikasi berulang dan tidak menjamin
   * urutannya, jadi sukses yang tiba setelah gagal adalah kejadian yang
   * diperkirakan, bukan anomali.
   */
  test('sukses yang tiba setelah gagal tidak membalikkan keadaan', () => {
    const failed = atStatus('FAILED')

    const result = applyProviderOutcome(failed, {
      outcome: 'SUCCEEDED',
      gatewayRef: 'midtrans-tx-late',
      amount: AMOUNT,
      reason: undefined,
    })

    expect(result.kind).toBe('out_of_order')
    expect(result.payment).toEqual(failed)
    expect(result.payment.status).toBe('FAILED')
  })

  test('gagal yang tiba setelah sukses tidak menghapus catatan pembayaran', () => {
    const succeeded = atStatus('SUCCEEDED')

    const result = applyProviderOutcome(succeeded, {
      outcome: 'FAILED',
      gatewayRef: 'midtrans-tx-late',
      amount: AMOUNT,
      reason: 'expire',
    })

    expect(result.kind).toBe('out_of_order')
    expect(result.payment).toEqual(succeeded)
  })

  test('gagal yang tiba setelah dana dikembalikan tidak mengubah keadaan', () => {
    const refunded = atStatus('REFUNDED')

    const result = applyProviderOutcome(refunded, {
      outcome: 'FAILED',
      gatewayRef: 'midtrans-tx-late',
      amount: AMOUNT,
      reason: 'expire',
    })

    expect(result.kind).toBe('out_of_order')
    expect(result.payment.status).toBe('REFUNDED')
  })
})

describe('notifikasi berulang dengan status yang sama', () => {
  test.each(['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'] as const)(
    'settlement kedua pada pembayaran %s tidak mengubah apa pun',
    (status) => {
      const before = atStatus(status)

      const result = applyProviderOutcome(before, {
        outcome: 'SUCCEEDED',
        gatewayRef: 'midtrans-tx-duplikat',
        amount: AMOUNT,
        reason: undefined,
      })

      expect(result.kind).toBe('unchanged')
      // Rujukan penyedia TIDAK ditimpa. Menimpanya akan membuat rujukan yang
      // dipakai refund menunjuk transaksi yang berbeda dari yang menagih.
      expect(result.payment).toEqual(before)
    },
  )

  test('penolakan kedua pada pembayaran yang sudah gagal tidak mengubah apa pun', () => {
    const before = atStatus('FAILED')

    const result = applyProviderOutcome(before, {
      outcome: 'FAILED',
      gatewayRef: 'midtrans-tx-duplikat',
      amount: AMOUNT,
      reason: 'cancel',
    })

    expect(result.kind).toBe('unchanged')
    expect(result.payment).toEqual(before)
  })
})

describe('nilai yang tidak cocok', () => {
  /**
   * Tanda tangan sudah memuat gross_amount, jadi nilai yang berbeda berarti
   * catatan kita yang berbeda dari penyedia — bukan notifikasi palsu. Menerima
   * begitu saja berarti menandai pembayaran berhasil untuk nilai yang tidak
   * pernah kita minta.
   */
  test('notifikasi dengan nilai berbeda ditolak, bukan diterapkan', () => {
    const result = applyProviderOutcome(pending(), {
      outcome: 'SUCCEEDED',
      gatewayRef: 'midtrans-tx-9',
      amount: money(1_000, 'IDR'),
      reason: undefined,
    })

    expect(result.kind).toBe('amount_mismatch')
    expect(result.payment.status).toBe('PENDING')
  })

  test('notifikasi dengan mata uang berbeda ditolak tanpa melempar', () => {
    const result = applyProviderOutcome(pending(), {
      outcome: 'SUCCEEDED',
      gatewayRef: 'midtrans-tx-9',
      amount: money(1_250_000, 'USD'),
      reason: undefined,
    })

    // Bukan pengecualian: perbandingan lintas mata uang di @tbe/money MELEMPAR,
    // dan melempar di sini akan membuat notifikasi cacat terlihat seperti
    // kerusakan sistem, lalu dicoba ulang penyedia tanpa henti.
    expect(result.kind).toBe('amount_mismatch')
  })

  test('nilai yang tidak cocok tidak diperiksa pada notifikasi pending', () => {
    // Midtrans mengirim gross_amount yang sama pada notifikasi pending, tetapi
    // notifikasi yang tidak mengubah apa pun tidak perlu dihalangi karenanya.
    const result = applyProviderOutcome(pending(), {
      outcome: 'PENDING',
      gatewayRef: 'midtrans-tx-9',
      amount: money(1_000, 'IDR'),
      reason: undefined,
    })

    expect(result.kind).toBe('unchanged')
  })
})

describe('imutabilitas', () => {
  test('menerapkan notifikasi tidak mengubah objek yang diterima', () => {
    const before = pending()
    const snapshot = structuredClone(before)

    applyProviderOutcome(before, {
      outcome: 'SUCCEEDED',
      gatewayRef: 'midtrans-tx-9',
      amount: AMOUNT,
      reason: undefined,
    })

    expect(before).toEqual(snapshot)
  })
})

describe('alasan kegagalan yang tidak disebutkan penyedia', () => {
  test('penolakan tanpa alasan tetap menyimpan alasan yang dapat dibaca', () => {
    const result = applyProviderOutcome(pending(), {
      outcome: 'FAILED',
      gatewayRef: 'midtrans-tx-9',
      amount: AMOUNT,
      reason: undefined,
    })

    expect(result.kind).toBe('applied')
    if (result.kind !== 'applied' || result.payment.status !== 'FAILED') return

    // Bukan string kosong dan bukan undefined: nilai ini ikut terbit sebagai
    // `reason` pada payment.failed, dan kontraknya menuntut string yang ada.
    // Pemberitahuan ke pengguna (FR-23) membacanya.
    expect(result.payment.failureReason).toBe('tidak disebutkan')
  })
})
