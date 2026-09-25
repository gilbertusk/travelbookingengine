import { money } from '@tbe/money'
import { describe, expect, test } from 'vitest'
import {
  FINAL_STATUSES,
  PAYMENT_STATUSES,
  PROVIDER_OUTCOMES,
  TRANSITIONS,
  applyProviderOutcome,
  createPayment,
  type Payment,
  type SettledPayment,
} from './payment.js'
import {
  REFUNDABLE_STATUSES,
  committedRefundTotal,
  refundableRemaining,
  requestRefund,
  settleRefund,
} from './refund.js'

const AMOUNT = money(1_000_000, 'IDR')

function succeeded(): SettledPayment {
  const result = applyProviderOutcome(
    createPayment({
      id: '11111111-1111-4111-8111-111111111111',
      bookingId: '22222222-2222-4222-8222-222222222222',
      amount: AMOUNT,
      idempotencyKey: 'bkg-1:attempt-1',
    }),
    { outcome: 'SUCCEEDED', gatewayRef: 'midtrans-tx-1', amount: AMOUNT, reason: undefined },
  )

  if (result.kind !== 'applied' || result.payment.status !== 'SUCCEEDED') {
    throw new Error('persiapan gagal: pembayaran seharusnya SUCCEEDED')
  }

  return result.payment
}

function failed(): Payment {
  const result = applyProviderOutcome(
    createPayment({
      id: '11111111-1111-4111-8111-111111111111',
      bookingId: '22222222-2222-4222-8222-222222222222',
      amount: AMOUNT,
      idempotencyKey: 'bkg-1:attempt-1',
    }),
    { outcome: 'FAILED', gatewayRef: 'midtrans-tx-1', amount: AMOUNT, reason: 'deny' },
  )

  if (result.kind !== 'applied') throw new Error('persiapan gagal')

  return result.payment
}

function accept(payment: Payment, amountMinor: number, requestId: string): SettledPayment {
  const result = requestRefund(payment, {
    id: `refund-${requestId}`,
    requestId,
    amount: money(amountMinor, 'IDR'),
    reason: 'supplier_failed',
  })

  if (result.kind !== 'accepted') throw new Error(`permintaan refund ${requestId} ditolak`)

  return result.payment
}

describe('keadaan yang menerima refund', () => {
  test.each(['PENDING', 'FAILED'] as const)(
    'refund pada pembayaran %s ditolak karena tidak ada uang yang masuk',
    (status) => {
      const payment = status === 'PENDING' ? pendingPayment() : failed()

      const result = requestRefund(payment, {
        id: 'refund-1',
        requestId: 'req-1',
        amount: money(1, 'IDR'),
        reason: 'manual',
      })

      expect(result.kind).toBe('rejected')
      if (result.kind !== 'rejected') return
      expect(result.reason).toBe('not_refundable')
    },
  )

  test('refund pada pembayaran yang sudah dikembalikan seluruhnya ditolak', () => {
    const fullyRefunded = settled(accept(succeeded(), 1_000_000, 'req-1'), 'req-1')
    expect(fullyRefunded.status).toBe('REFUNDED')

    const result = requestRefund(fullyRefunded, {
      id: 'refund-2',
      requestId: 'req-2',
      amount: money(1, 'IDR'),
      reason: 'manual',
    })

    expect(result.kind).toBe('rejected')
    if (result.kind !== 'rejected') return
    expect(result.reason).toBe('not_refundable')
  })

  /**
   * NFR-06 di service ini: tepat keadaan yang dinyatakan final yang tidak punya
   * satu pun transisi keluar. Dibuktikan atas KEDUA tabel sekaligus — notifikasi
   * penyedia dan penerimaan refund — karena masing-masing sendiri tidak cukup.
   *
   * Percobaan membuktikannya dari tabel notifikasi saja (lihat payment.test.ts)
   * menyatakan SUCCEEDED dan PARTIALLY_REFUNDED sebagai final, padahal dana
   * keduanya masih dapat dikembalikan.
   */
  test('tepat keadaan final yang tidak punya transisi keluar sama sekali', () => {
    const frozen = PAYMENT_STATUSES.filter(
      (status) =>
        PROVIDER_OUTCOMES.every((outcome) => TRANSITIONS[status][outcome] !== 'apply') &&
        !REFUNDABLE_STATUSES[status],
    )

    expect([...frozen].sort()).toEqual([...FINAL_STATUSES].sort())
  })
})

describe('batas total refund', () => {
  /**
   * Definisi Selesai "total refund tidak dapat melebihi nilai pembayaran".
   * Ditegakkan di sini, di domain — bukan hanya sebagai batasan basis data.
   * Batasan basis data menolak setelah panggilan ke penyedia sudah berjalan,
   * dan pada titik itu uangnya sudah keluar.
   */
  test('satu refund melebihi nilai pembayaran ditolak', () => {
    const result = requestRefund(succeeded(), {
      id: 'refund-1',
      requestId: 'req-1',
      amount: money(1_000_001, 'IDR'),
      reason: 'supplier_failed',
    })

    expect(result.kind).toBe('rejected')
    if (result.kind !== 'rejected') return
    expect(result.reason).toBe('exceeds_total')
  })

  test('refund tepat sebesar nilai pembayaran diterima', () => {
    const result = requestRefund(succeeded(), {
      id: 'refund-1',
      requestId: 'req-1',
      amount: AMOUNT,
      reason: 'supplier_failed',
    })

    expect(result.kind).toBe('accepted')
  })

  /**
   * Yang membuktikan refund yang MASIH MENUNGGU ikut dihitung: dua permintaan
   * yang masing-masing di bawah batas, tetapi jumlahnya melebihi.
   *
   * Kalau hanya refund yang sudah berhasil yang dihitung, keduanya lolos, dua
   * panggilan refund berjalan ke penyedia, dan kelebihannya baru terlihat
   * setelah uangnya keluar.
   */
  test('refund kedua yang membuat total melebihi nilai pembayaran ditolak', () => {
    const afterFirst = accept(succeeded(), 600_000, 'req-1')

    const result = requestRefund(afterFirst, {
      id: 'refund-2',
      requestId: 'req-2',
      amount: money(500_000, 'IDR'),
      reason: 'supplier_failed',
    })

    expect(result.kind).toBe('rejected')
    if (result.kind !== 'rejected') return
    expect(result.reason).toBe('exceeds_total')
  })

  test('refund kedua yang masih di dalam batas diterima', () => {
    const afterFirst = accept(succeeded(), 600_000, 'req-1')

    const result = requestRefund(afterFirst, {
      id: 'refund-2',
      requestId: 'req-2',
      amount: money(400_000, 'IDR'),
      reason: 'supplier_failed',
    })

    expect(result.kind).toBe('accepted')
  })

  test('refund yang gagal tidak menghabiskan kuota', () => {
    const afterFirst = accept(succeeded(), 600_000, 'req-1')
    const afterFailure = settleFailed(afterFirst, 'req-1')

    expect(refundableRemaining(afterFailure)).toEqual(AMOUNT)
    expect(committedRefundTotal(afterFailure)).toEqual(money(0, 'IDR'))

    const result = requestRefund(afterFailure, {
      id: 'refund-2',
      requestId: 'req-2',
      amount: AMOUNT,
      reason: 'supplier_failed',
    })

    expect(result.kind).toBe('accepted')
  })

  test('sisa yang dapat direfund berkurang sesuai refund yang menunggu', () => {
    const afterFirst = accept(succeeded(), 250_000, 'req-1')

    expect(refundableRemaining(afterFirst)).toEqual(money(750_000, 'IDR'))
  })

  test('refund bermata uang berbeda ditolak tanpa melempar', () => {
    const result = requestRefund(succeeded(), {
      id: 'refund-1',
      requestId: 'req-1',
      amount: money(10, 'USD'),
      reason: 'manual',
    })

    expect(result.kind).toBe('rejected')
    if (result.kind !== 'rejected') return
    expect(result.reason).toBe('currency_mismatch')
  })

  test.each([0, -1])('refund bernilai %i ditolak', (amountMinor) => {
    const result = requestRefund(succeeded(), {
      id: 'refund-1',
      requestId: 'req-1',
      amount: money(amountMinor, 'IDR'),
      reason: 'manual',
    })

    expect(result.kind).toBe('rejected')
    if (result.kind !== 'rejected') return
    expect(result.reason).toBe('not_positive')
  })
})

describe('idempotensi terhadap pengenal permintaan', () => {
  /**
   * Definisi Selesai "refund idempoten terhadap pengenal permintaan". Ini
   * lapisan domainnya; lapisan yang menegakkannya terhadap balapan sungguhan
   * adalah batasan UNIK pada kolom request_id — lihat
   * application/refund-payment.ts.
   */
  test('permintaan kedua dengan pengenal yang sama tidak menambah refund', () => {
    const afterFirst = accept(succeeded(), 400_000, 'req-1')

    const again = requestRefund(afterFirst, {
      id: 'refund-lain',
      requestId: 'req-1',
      amount: money(400_000, 'IDR'),
      reason: 'supplier_failed',
    })

    expect(again.kind).toBe('already_requested')
    if (again.kind !== 'already_requested') return

    expect(again.payment.refunds).toHaveLength(1)
    // Refund yang dikembalikan adalah yang PERTAMA, lengkap dengan id-nya.
    // Mengembalikan yang baru akan membuat pemanggil menyimpan baris kedua.
    expect(again.refund.id).toBe('refund-req-1')
    expect(again.payment).toEqual(afterFirst)
  })

  test('permintaan ulang dengan nilai berbeda tetap mengembalikan yang pertama', () => {
    const afterFirst = accept(succeeded(), 400_000, 'req-1')

    const again = requestRefund(afterFirst, {
      id: 'refund-lain',
      requestId: 'req-1',
      amount: money(900_000, 'IDR'),
      reason: 'manual',
    })

    // Nilai yang berbeda pada pengenal yang sama adalah perintah yang salah,
    // bukan permintaan baru. Yang berlaku tetap yang pertama; menerapkan yang
    // kedua berarti mengembalikan dana dua kali dengan total yang lebih besar.
    expect(again.kind).toBe('already_requested')
    if (again.kind !== 'already_requested') return
    expect(again.refund.amount).toEqual(money(400_000, 'IDR'))
  })
})

describe('penyelesaian refund', () => {
  test('refund berhasil sebesar seluruh pembayaran membuat pembayaran REFUNDED', () => {
    const result = settled(accept(succeeded(), 1_000_000, 'req-1'), 'req-1')

    expect(result.status).toBe('REFUNDED')
    expect(result.refunds[0]?.status).toBe('SUCCEEDED')
    expect(result.refunds[0]?.gatewayRef).toBe('midtrans-refund-req-1')
  })

  test('refund berhasil sebagian membuat pembayaran PARTIALLY_REFUNDED', () => {
    const result = settled(accept(succeeded(), 300_000, 'req-1'), 'req-1')

    expect(result.status).toBe('PARTIALLY_REFUNDED')
  })

  test('dua refund sebagian yang menutup seluruh nilai membuat REFUNDED', () => {
    const first = settled(accept(succeeded(), 300_000, 'req-1'), 'req-1')
    const second = settled(accept(first, 700_000, 'req-2'), 'req-2')

    expect(second.status).toBe('REFUNDED')
  })

  test('refund yang gagal mengembalikan pembayaran ke SUCCEEDED', () => {
    const result = settleFailed(accept(succeeded(), 300_000, 'req-1'), 'req-1')

    expect(result.status).toBe('SUCCEEDED')
    expect(result.refunds[0]?.status).toBe('FAILED')
  })

  test('penyelesaian refund yang tidak dikenal tidak mengubah apa pun', () => {
    const before = accept(succeeded(), 300_000, 'req-1')

    const result = settleRefund(before, 'req-tidak-ada', {
      kind: 'succeeded',
      gatewayRef: 'x',
    })

    expect(result.kind).toBe('unknown_refund')
    expect(result.payment).toEqual(before)
  })

  test('penyelesaian kedua pada refund yang sudah selesai tidak mengubah apa pun', () => {
    const once = settled(accept(succeeded(), 300_000, 'req-1'), 'req-1')

    const result = settleRefund(once, 'req-1', {
      kind: 'failed',
    })

    // Perintah refund yang dikirim ulang RabbitMQ setelah keberhasilan tidak
    // boleh mengubah refund yang sudah berhasil menjadi gagal.
    expect(result.kind).toBe('unchanged')
    expect(result.payment).toEqual(once)
  })
})

describe('imutabilitas', () => {
  test('permintaan refund tidak mengubah pembayaran yang diterima', () => {
    const before = succeeded()
    const snapshot = structuredClone(before)

    requestRefund(before, {
      id: 'refund-1',
      requestId: 'req-1',
      amount: money(100, 'IDR'),
      reason: 'manual',
    })

    expect(before).toEqual(snapshot)
  })

  test('penyelesaian refund tidak mengubah pembayaran yang diterima', () => {
    const before = accept(succeeded(), 100, 'req-1')
    const snapshot = structuredClone(before)

    settleRefund(before, 'req-1', { kind: 'succeeded', gatewayRef: 'x' })

    expect(before).toEqual(snapshot)
  })
})

function pendingPayment(): Payment {
  return createPayment({
    id: '11111111-1111-4111-8111-111111111111',
    bookingId: '22222222-2222-4222-8222-222222222222',
    amount: AMOUNT,
    idempotencyKey: 'bkg-1:attempt-1',
  })
}

function settled(payment: SettledPayment, requestId: string): SettledPayment {
  const result = settleRefund(payment, requestId, {
    kind: 'succeeded',
    gatewayRef: `midtrans-refund-${requestId}`,
  })

  if (result.kind !== 'settled') throw new Error(`penyelesaian ${requestId} gagal`)

  return result.payment
}

function settleFailed(payment: SettledPayment, requestId: string): SettledPayment {
  const result = settleRefund(payment, requestId, { kind: 'failed' })

  if (result.kind !== 'settled') throw new Error(`penyelesaian ${requestId} gagal`)

  return result.payment
}
