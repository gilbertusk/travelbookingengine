import { money } from '@tbe/money'
import { describe, expect, test } from 'vitest'
import { REDACTED } from '../domain/redaction.js'
import {
  LOG_LEVELS,
  TEST_AMOUNT,
  TEST_PAYMENT_ID,
  givenPendingPayment,
  harness,
  racyWebhookLedger,
  rejectingVerifier,
  verifierAccepting,
  type Harness,
} from '../testing/fakes.js'
import { handleNotification, type RawNotification } from './handle-notification.js'

function notification(overrides: Partial<RawNotification> = {}): RawNotification {
  return {
    orderId: TEST_PAYMENT_ID,
    transactionId: 'midtrans-tx-1',
    transactionStatus: 'settlement',
    fraudStatus: undefined,
    statusCode: '200',
    grossAmount: '1250000.00',
    currency: 'IDR',
    signatureKey: 'tanda-tangan-yang-dianggap-sah',
    payload: {
      order_id: TEST_PAYMENT_ID,
      transaction_id: 'midtrans-tx-1',
      transaction_status: 'settlement',
      gross_amount: '1250000.00',
      signature_key: 'tanda-tangan-yang-dianggap-sah',
    },
    ...overrides,
  }
}

function appliedCount(results: readonly { kind: string }[]): number {
  return results.filter((result) => result.kind === 'applied').length
}

function updates(world: Harness): readonly string[] {
  return world.payments.writes.filter((write) => write.startsWith('update:'))
}

describe('notifikasi yang sah', () => {
  test('settlement membuat pembayaran SUCCEEDED dan menerbitkan payment.succeeded', async () => {
    const world = harness()
    await givenPendingPayment(world)

    const result = await handleNotification(world.deps, notification())

    expect(result.kind).toBe('applied')
    expect(world.payments.rows.get(TEST_PAYMENT_ID)?.status).toBe('SUCCEEDED')
    expect(world.events.published).toHaveLength(1)
    expect(world.events.published[0]).toMatchObject({
      type: 'succeeded',
      paymentId: TEST_PAYMENT_ID,
      amount: TEST_AMOUNT,
      gatewayRef: 'midtrans-tx-1',
    })
  })

  test('penolakan membuat pembayaran FAILED dan menerbitkan payment.failed', async () => {
    const world = harness()
    await givenPendingPayment(world)

    const result = await handleNotification(
      world.deps,
      notification({ transactionStatus: 'deny', statusCode: '202' }),
    )

    expect(result.kind).toBe('applied')
    expect(world.payments.rows.get(TEST_PAYMENT_ID)?.status).toBe('FAILED')
    expect(world.events.published[0]).toMatchObject({ type: 'failed', reason: 'deny' })
  })

  /**
   * "Peristiwa diterbitkan SETELAH keadaan tersimpan, tidak pernah sebelumnya."
   *
   * Dibuktikan atas URUTAN efek yang sesungguhnya, bukan dengan memeriksa bahwa
   * keduanya terjadi. Peristiwa yang mendahului penyimpanan akan dibaca saga
   * yang lalu menanyakan pembayaran yang belum ada — dan itu gagal secara
   * sporadis, hanya ketika consumer cukup cepat.
   */
  test('peristiwa diterbitkan setelah keadaan tersimpan', async () => {
    const world = harness()
    await givenPendingPayment(world)

    await handleNotification(world.deps, notification())

    expect(world.effects).toEqual([
      `update:${TEST_PAYMENT_ID}:SUCCEEDED`,
      `event:payment.succeeded:${TEST_PAYMENT_ID}`,
    ])
  })

  test('hasil pemrosesan dicatat pada buku besar beserta pembayarannya', async () => {
    const world = harness()
    await givenPendingPayment(world)

    await handleNotification(world.deps, notification())

    expect(world.ledger.rows.get('midtrans-tx-1')).toMatchObject({
      outcome: 'applied',
      paymentId: TEST_PAYMENT_ID,
    })
  })

  test('payload yang dicatat sudah diredaksi', async () => {
    const world = harness()
    await givenPendingPayment(world)

    await handleNotification(world.deps, notification())

    const stored = world.ledger.rows.get('midtrans-tx-1')?.payload as Record<string, unknown>

    // signature_key yang tersimpan adalah setengah bahan untuk memalsukan
    // notifikasi berikutnya.
    expect(stored.signature_key).toBe(REDACTED)
    expect(stored.order_id).toBe(TEST_PAYMENT_ID)
  })
})

describe('idempotensi', () => {
  test('notifikasi yang sama diproses dua kali hanya menghasilkan satu efek', async () => {
    const world = harness()
    await givenPendingPayment(world)

    const first = await handleNotification(world.deps, notification())
    const second = await handleNotification(world.deps, notification())

    expect(first.kind).toBe('applied')
    expect(second.kind).toBe('duplicate')
    if (second.kind !== 'duplicate') return

    // Hasil sebelumnya dikembalikan apa adanya, tanpa efek samping apa pun.
    expect(second.outcome).toBe('applied')
    expect(world.events.published).toHaveLength(1)
    expect(updates(world)).toHaveLength(1)
  })

  /**
   * Definisi Selesai: "sepuluh webhook identik serentak menghasilkan tepat satu
   * efek". Ini uji yang berbeda dari yang di atas — yang di atas hanya menguji
   * percabangan, yang ini menguji BALAPAN.
   *
   * Tanpa Postgres, balapannya dijalankan terhadap palsuan yang meniru batasan
   * UNIK: pemeriksaan dan penulisan terjadi dalam satu langkah sinkron, sehingga
   * penyisipan kedua ditolak persis seperti `INSERT` kedua ditolak basis data.
   *
   * Bahwa uji ini TIDAK hampa dibuktikan uji berikutnya.
   */
  test('sepuluh webhook identik serentak menghasilkan tepat satu efek', async () => {
    const world = harness()
    await givenPendingPayment(world)

    const results = await Promise.all(
      Array.from({ length: 10 }, () => handleNotification(world.deps, notification())),
    )

    expect(appliedCount(results)).toBe(1)
    expect(world.events.published).toHaveLength(1)
    expect(updates(world)).toHaveLength(1)
    expect(world.ledger.claims).toHaveLength(10)
    expect(world.payments.rows.get(TEST_PAYMENT_ID)?.status).toBe('SUCCEEDED')
  })

  /**
   * Bukti bahwa uji di atas bermakna.
   *
   * Palsuan tandingan memakai pola "periksa dulu baru tulis" — persis yang
   * terjadi bila kode sungguhan memanggil `findUnique` lalu `create` alih-alih
   * mengandalkan batasan UNIK. Uji yang sama harus GAGAL padanya, dan di sini
   * kegagalan itu yang ditegaskan.
   *
   * Tanpa uji ini, "sepuluh webhook serentak" bisa lulus hanya karena
   * palsuannya tidak pernah benar-benar menghadapi balapan, dan tidak ada yang
   * dapat membedakan keduanya.
   */
  test('uji balapan tidak hampa: pola periksa-dulu-baru-tulis menghasilkan banyak efek', async () => {
    const world = harness({ ledger: racyWebhookLedger() })
    await givenPendingPayment(world)

    const results = await Promise.all(
      Array.from({ length: 10 }, () => handleNotification(world.deps, notification())),
    )

    expect(appliedCount(results)).toBeGreaterThan(1)
    expect(world.events.published.length).toBeGreaterThan(1)
  })

  test('notifikasi berbeda dengan status sama hanya mengubah keadaan sekali', async () => {
    const world = harness()
    await givenPendingPayment(world)

    await handleNotification(world.deps, notification({ transactionId: 'midtrans-tx-1' }))
    const second = await handleNotification(
      world.deps,
      notification({ transactionId: 'midtrans-tx-2' }),
    )

    // Pengenal peristiwa berbeda, jadi buku besar meloloskannya — dan yang
    // menahan perubahan kedua adalah tabel transisi, bukan idempotensi.
    expect(second.kind).toBe('ignored')
    if (second.kind !== 'ignored') return
    expect(second.why).toBe('duplicate_status')
    expect(world.events.published).toHaveLength(1)
    expect(world.ledger.rows.get('midtrans-tx-2')?.outcome).toBe('ignored_duplicate_status')
  })

  test('klaim yang belum selesai ditolak agar penyedia mengirim ulang', async () => {
    const world = harness()
    await givenPendingPayment(world)

    // Meniru proses yang mati setelah mengklaim tetapi sebelum menutup.
    await world.ledger.claim({ providerEventId: 'midtrans-tx-1', payload: {} })

    const result = await handleNotification(world.deps, notification())

    // BUKAN 'duplicate': memperlakukannya sebagai duplikat yang sudah selesai
    // berarti notifikasi itu hilang selamanya, dan pembayaran tertinggal PENDING.
    expect(result.kind).toBe('in_progress')
    expect(world.events.published).toHaveLength(0)
    expect(world.payments.rows.get(TEST_PAYMENT_ID)?.status).toBe('PENDING')
  })
})

describe('tanda tangan', () => {
  test('tanda tangan tidak sah ditolak', async () => {
    const world = harness({ verifier: rejectingVerifier() })
    await givenPendingPayment(world)

    const result = await handleNotification(world.deps, notification())

    expect(result.kind).toBe('rejected')
    if (result.kind !== 'rejected') return
    expect(result.why).toBe('invalid_signature')
    expect(world.payments.rows.get(TEST_PAYMENT_ID)?.status).toBe('PENDING')
    expect(world.events.published).toHaveLength(0)
  })

  test('tanda tangan tidak sah dicatat sebagai peringatan keamanan', async () => {
    const world = harness({ verifier: rejectingVerifier() })
    await givenPendingPayment(world)

    await handleNotification(world.deps, notification())

    const warning = world.lines.find((line) => line.level === LOG_LEVELS.warn)

    expect(warning).toBeDefined()
    expect(warning?.security).toBe(true)
    expect(warning?.providerEventId).toBe('midtrans-tx-1')
    // Tanda tangan yang ditolak TIDAK ikut dicatat: log adalah tempat lain yang
    // dibaca lebih banyak orang daripada basis data.
    expect(JSON.stringify(warning)).not.toContain('tanda-tangan-yang-dianggap-sah')
  })

  /**
   * Notifikasi tanpa tanda tangan sah TIDAK boleh menempati pengenal
   * peristiwanya di buku besar. Kalau boleh, siapa pun yang mengetahui sebuah
   * transaction_id dapat mengirim notifikasi palsu lebih dulu, membuat
   * pengenalnya terpakai, dan notifikasi sungguhan yang tiba kemudian akan
   * dianggap duplikat lalu diabaikan — pembayaran yang sah hilang tanpa jejak.
   */
  test('tanda tangan tidak sah tidak menghabiskan pengenal peristiwa', async () => {
    const world = harness({ verifier: verifierAccepting('tanda-tangan-yang-dianggap-sah') })
    await givenPendingPayment(world)

    const forged = await handleNotification(
      world.deps,
      notification({ signatureKey: 'tanda-tangan-palsu' }),
    )
    expect(forged.kind).toBe('rejected')
    expect(world.ledger.rows.size).toBe(0)

    const genuine = await handleNotification(world.deps, notification())

    expect(genuine.kind).toBe('applied')
  })

  test('verifikasi menerima bahan yang benar, bukan sekadar dipanggil', async () => {
    const world = harness({ verifier: verifierAccepting('tanda-tangan-yang-dianggap-sah') })
    await givenPendingPayment(world)

    const result = await handleNotification(world.deps, notification())

    expect(result.kind).toBe('applied')
  })
})

describe('notifikasi tidak berurutan', () => {
  test('sukses yang tiba setelah gagal tidak membalikkan keadaan final', async () => {
    const world = harness()
    await givenPendingPayment(world)

    await handleNotification(
      world.deps,
      notification({ transactionId: 'tx-gagal', transactionStatus: 'deny' }),
    )

    const late = await handleNotification(
      world.deps,
      notification({ transactionId: 'tx-sukses', transactionStatus: 'settlement' }),
    )

    expect(late.kind).toBe('ignored')
    if (late.kind !== 'ignored') return
    expect(late.why).toBe('out_of_order')

    expect(world.payments.rows.get(TEST_PAYMENT_ID)?.status).toBe('FAILED')
    // Hanya satu peristiwa: payment.failed. payment.succeeded TIDAK terbit —
    // kalau terbit, saga akan mengonfirmasi kamar atas pembayaran yang gagal.
    expect(world.events.published).toHaveLength(1)
    expect(world.events.published[0]?.type).toBe('failed')
  })

  test('notifikasi tidak berurutan tercatat, bukan dibuang diam-diam', async () => {
    const world = harness()
    await givenPendingPayment(world)

    await handleNotification(
      world.deps,
      notification({ transactionId: 'tx-gagal', transactionStatus: 'deny' }),
    )
    await handleNotification(world.deps, notification({ transactionId: 'tx-sukses' }))

    // Tanpa catatan ini, pertanyaan "kenapa pembayaran ini gagal padahal
    // penyedia bilang berhasil" tidak dapat dijawab.
    expect(world.ledger.rows.get('tx-sukses')?.outcome).toBe('ignored_out_of_order')

    const warning = world.lines.find((line) => line.level === LOG_LEVELS.warn)
    expect(warning?.attempted).toBe('SUCCEEDED')
  })
})

describe('notifikasi yang ditolak', () => {
  test('pembayaran yang tidak dikenal ditolak dan dicatat', async () => {
    const world = harness()

    const result = await handleNotification(world.deps, notification())

    expect(result.kind).toBe('rejected')
    if (result.kind !== 'rejected') return
    expect(result.why).toBe('unknown_payment')
    expect(world.ledger.rows.get('midtrans-tx-1')?.outcome).toBe('rejected_unknown_payment')
  })

  test('nilai yang tidak cocok ditolak dan dicatat sebagai galat', async () => {
    const world = harness()
    await givenPendingPayment(world, { amount: money(999, 'IDR') })

    const result = await handleNotification(world.deps, notification())

    expect(result.kind).toBe('rejected')
    if (result.kind !== 'rejected') return
    expect(result.why).toBe('amount_mismatch')

    expect(world.payments.rows.get(TEST_PAYMENT_ID)?.status).toBe('PENDING')
    expect(world.events.published).toHaveLength(0)
    expect(world.ledger.rows.get('midtrans-tx-1')?.outcome).toBe('rejected_amount_mismatch')

    // Tingkat error, bukan warn: catatan kita berbeda dari penyedia soal uang,
    // dan itu butuh tindakan manusia.
    expect(world.lines.some((line) => line.level === LOG_LEVELS.error)).toBe(true)
  })

  test('gross_amount yang tidak dapat diurai ditolak tanpa menyentuh buku besar', async () => {
    const world = harness()
    await givenPendingPayment(world)

    const result = await handleNotification(world.deps, notification({ grossAmount: '1e5' }))

    expect(result.kind).toBe('rejected')
    if (result.kind !== 'rejected') return
    expect(result.why).toBe('invalid_amount')
    expect(world.ledger.rows.size).toBe(0)
  })

  test('mata uang yang tidak sesuai pembayaran ditolak sebagai nilai tidak cocok', async () => {
    const world = harness()
    await givenPendingPayment(world)

    const result = await handleNotification(world.deps, notification({ currency: 'USD' }))

    expect(result.kind).toBe('rejected')
    if (result.kind !== 'rejected') return
    expect(result.why).toBe('amount_mismatch')
  })
})

describe('status yang tidak diproses', () => {
  test('status yang tidak dikenal diabaikan tanpa mengubah keadaan', async () => {
    const world = harness()
    await givenPendingPayment(world)

    const result = await handleNotification(
      world.deps,
      notification({ transactionStatus: 'status_yang_belum_ada' }),
    )

    expect(result.kind).toBe('ignored')
    if (result.kind !== 'ignored') return
    expect(result.why).toBe('unsupported_status')
    expect(world.payments.rows.get(TEST_PAYMENT_ID)?.status).toBe('PENDING')
  })

  test.each(['refund', 'partial_refund'])(
    'notifikasi %s dari penyedia diabaikan karena refund dimiliki alur refund',
    async (transactionStatus) => {
      const world = harness()
      await givenPendingPayment(world)

      const result = await handleNotification(world.deps, notification({ transactionStatus }))

      expect(result.kind).toBe('ignored')
      if (result.kind !== 'ignored') return
      expect(result.why).toBe('provider_refund_status')
    },
  )

  test('status yang tidak diproses tidak menempati pengenal peristiwa', async () => {
    const world = harness()
    await givenPendingPayment(world)

    await handleNotification(world.deps, notification({ transactionStatus: 'refund' }))

    // Tidak ada keadaan yang berubah, jadi pengiriman ulang tidak berbahaya —
    // dan pengenal yang tidak terpakai tetap tersedia untuk notifikasi yang
    // benar-benar mengubah sesuatu.
    expect(world.ledger.rows.size).toBe(0)
  })

  test('notifikasi pending tidak mengubah keadaan tetapi tercatat', async () => {
    const world = harness()
    await givenPendingPayment(world)

    const result = await handleNotification(
      world.deps,
      notification({ transactionStatus: 'pending', statusCode: '201' }),
    )

    expect(result.kind).toBe('ignored')
    if (result.kind !== 'ignored') return
    expect(result.why).toBe('duplicate_status')
    expect(world.ledger.rows.get('midtrans-tx-1')?.outcome).toBe('ignored_duplicate_status')
    expect(world.events.published).toHaveLength(0)
  })

  test('capture dengan fraud_status challenge tidak menandai pembayaran berhasil', async () => {
    const world = harness()
    await givenPendingPayment(world)

    const result = await handleNotification(
      world.deps,
      notification({ transactionStatus: 'capture', fraudStatus: 'challenge' }),
    )

    expect(result.kind).toBe('ignored')
    expect(world.payments.rows.get(TEST_PAYMENT_ID)?.status).toBe('PENDING')
    expect(world.events.published).toHaveLength(0)
  })
})
