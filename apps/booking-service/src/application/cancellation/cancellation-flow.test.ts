import { money } from '@tbe/money'
import { describe, expect, test } from 'vitest'
import { cancellationWorld, type CancellationWorld } from '../../testing/cancellation-world.js'
import { ERROR_LEVEL } from '../../testing/fakes.js'
import { PAYMENT_ID, REFUND_ID, SUPPLIER_REF } from '../../testing/saga-world.js'
import { cancellationRefundRequestId } from './commands.js'
import { sweepCancellations } from './sweep.js'

/**
 * Uji wajib Step 25.
 *
 * Seluruh jalur berjalan lewat kode produksi — use case, reaksi, repository,
 * unit kerja, outbox — di atas basis data palsuan yang meniru transaksi
 * Postgres, seperti uji saga Step 19. Yang dipalsukan hanya service lain:
 * katalog (zona waktu properti), supplier-service, dan payment-service.
 *
 * Pemesanan contoh: check-in 10 November 2026 di Bali (UTC+8), jadi awal
 * tanggal masuknya 9 November 16.00 UTC. Supplier menjawab "refundable, gratis
 * sampai 3 hari sebelumnya": 100% sampai 72 jam, 50% sampai 24 jam, 0%.
 * Pembayarannya Rp 2.442.000.
 */

const HOUR = 3_600_000
const BALI_CHECK_IN_STARTS = Date.parse('2026-11-09T16:00:00Z')
const PAID = money(2_442_000, 'IDR')

function at(world: CancellationWorld, instant: number): void {
  world.advance(instant - world.now().getTime())
}

function hoursBeforeCheckIn(world: CancellationWorld, hours: number): void {
  at(world, BALI_CHECK_IN_STARTS - hours * HOUR)
}

async function cancelling(world: CancellationWorld) {
  const booking = await world.confirmed()
  const result = await world.cancel(booking)
  if (result.kind !== 'accepted') throw new Error(`pembatalan tidak diterima: ${result.kind}`)

  return booking
}

describe('pratinjau: perhitungan per jenjang kebijakan', () => {
  test.each([
    ['lebih dari 72 jam sebelumnya', 100, 100, 2_442_000],
    ['di antara 72 dan 24 jam', 48, 50, 1_221_000],
    ['kurang dari 24 jam', 2, 0, 0],
  ])('%s', async (_name, hours, percent, refundMinor) => {
    const world = cancellationWorld()
    const booking = await world.confirmed()
    hoursBeforeCheckIn(world, hours)

    const preview = await world.preview(booking)

    expect(preview).toMatchObject({
      kind: 'quoted',
      quote: { percent, refund: money(refundMinor, 'IDR'), timeZone: 'Asia/Makassar' },
    })
  })

  test('pembatalan setelah tenggat menghasilkan nol dengan penjelasan tenggat yang terlewat', async () => {
    const world = cancellationWorld()
    const booking = await world.confirmed()
    hoursBeforeCheckIn(world, 2)

    const preview = await world.preview(booking)

    expect(preview.kind === 'quoted' && preview.quote.nothingBack).toEqual({
      kind: 'past_deadline',
      lastRefund: { percent: 50, until: new Date(BALI_CHECK_IN_STARTS - 24 * HOUR) },
    })
  })

  test('pratinjau tidak mengubah apa pun', async () => {
    const world = cancellationWorld()
    const booking = await world.confirmed()
    const sentBefore = world.sent(booking.id)

    await world.preview(booking)

    expect(await world.booking(booking.id)).toEqual(booking)
    expect(world.sent(booking.id)).toEqual(sentBefore)
  })
})

describe('tenggat dihitung dengan zona waktu properti', () => {
  /**
   * Contoh di step doc: pemesan di Jakarta membatalkan hotel di Tokyo pukul
   * 23.00 WIB, mengira masih di dalam tenggat 24 jam. 23.00 WIB 8 November =
   * 16.00 UTC = 01.00 tanggal 9 di Tokyo — tenggat 24 jam untuk check-in 10
   * November di Tokyo sudah lewat satu jam. Pemesanan yang sama di Jakarta
   * masih satu jam di dalam tenggat.
   */
  test.each([
    ['Asia/Tokyo', 0],
    ['Asia/Jakarta', 50],
  ])('pukul 23.00 WIB, properti di %s: %i%%', async (timeZone, percent) => {
    const world = cancellationWorld()
    world.properties.answer = { kind: 'found', timeZone }
    const booking = await world.confirmed()
    at(world, Date.parse('2026-11-08T16:00:00Z'))

    const preview = await world.preview(booking)

    expect(preview.kind === 'quoted' && preview.quote.percent).toBe(percent)
  })

  test('zona waktu ditanyakan ke katalog untuk properti pemesanan itu', async () => {
    const world = cancellationWorld()
    const booking = await world.confirmed()

    await world.preview(booking)

    expect(world.properties.lookups).toEqual(['SKY/prop-bali-001'])
  })
})

describe('kebijakan yang dipakai adalah yang tersimpan saat memesan', () => {
  test('rate plan yang kini non-refundable tidak mengubah pemesanan yang sudah ada', async () => {
    const world = cancellationWorld()
    const booking = await world.confirmed()

    // Supplier mengubah rate plan ini sesudah pemesanan terkonfirmasi.
    world.suppliers.supplierPolicy = { refundable: false }
    const later = await world.preview(booking)

    expect(later).toMatchObject({ kind: 'quoted', quote: { percent: 100, refund: PAID } })
  })

  test('kebijakan yang dikirim peramban tidak dipakai, yang dijawab supplier yang dipakai', async () => {
    // Peramban mengirim "refundable, gratis 3 hari" (priceCheckRequest);
    // supplier menjawab rate ini non-refundable sejak price check.
    const world = cancellationWorld()
    world.suppliers.supplierPolicy = { refundable: false }
    const booking = await world.confirmed()

    const preview = await world.preview(booking)

    expect(preview).toMatchObject({
      kind: 'quoted',
      quote: { percent: 0, refund: money(0, 'IDR'), nothingBack: { kind: 'non_refundable' } },
    })
  })
})

describe('saga pembatalan', () => {
  test('permintaan memindahkan ke CANCELLING dan meminta supplier membatalkan, belum ada refund', async () => {
    const world = cancellationWorld()
    const booking = await cancelling(world)

    expect(await world.booking(booking.id)).toMatchObject({
      status: 'CANCELLING',
      cancellationRequest: { refund: PAID, percent: 100 },
      cancellationStage: { step: 'supplier' },
    })
    expect(world.commands(booking.id, 'supplier.cancel')).toEqual([
      { bookingId: booking.id, supplier: 'SKY', supplierRef: SUPPLIER_REF },
    ])
    expect(world.commands(booking.id, 'payment.refund')).toEqual([])
  })

  test('supplier membatalkan: refund sebesar persetujuan dikirim, lalu tuntas', async () => {
    const world = cancellationWorld()
    const booking = await cancelling(world)

    expect(await world.supplierCancelled(booking)).toBe('applied')
    expect(world.commands(booking.id, 'payment.refund')).toEqual([
      {
        refundRequestId: cancellationRefundRequestId(booking.id, PAYMENT_ID),
        paymentId: PAYMENT_ID,
        bookingId: booking.id,
        amount: { amountMinor: 2_442_000, currency: 'IDR' },
        reason: 'user_cancelled',
      },
    ])

    expect(await world.paymentRefunded(booking)).toBe('applied')
    expect(await world.booking(booking.id)).toMatchObject({
      status: 'CANCELLED',
      cancellation: 'user_request',
      cancellationSettlement: { kind: 'refunded', refundId: REFUND_ID },
    })
    const cancelled = world.outbox().find((row) => row.messageType === 'booking.cancelled')
    expect(cancelled?.payload).toEqual({
      bookingId: booking.id,
      reason: 'user_request',
      refundAmount: { amountMinor: 2_442_000, currency: 'IDR' },
    })
  })

  test('nilai yang dikembalikan adalah nilai saat diminta, bukan saat supplier menjawab', async () => {
    // Diminta 49 jam sebelum (50%); supplier baru menjawab setelah tenggat 24
    // jam lewat. Pengguna tidak kehilangan jenjangnya karena supplier lambat.
    const world = cancellationWorld()
    const booking = await world.confirmed()
    hoursBeforeCheckIn(world, 49)
    await world.cancel(booking)
    hoursBeforeCheckIn(world, 20)

    await world.supplierCancelled(booking)

    expect(world.commands(booking.id, 'payment.refund')).toMatchObject([
      { amount: { amountMinor: 1_221_000, currency: 'IDR' } },
    ])
  })

  test('tanpa dana kembali: tuntas begitu supplier membatalkan, tanpa perintah refund', async () => {
    const world = cancellationWorld()
    const booking = await world.confirmed()
    hoursBeforeCheckIn(world, 2)
    await world.cancel(booking)

    await world.supplierCancelled(booking)

    expect(await world.booking(booking.id)).toMatchObject({
      status: 'CANCELLED',
      cancellationSettlement: { kind: 'nothing_due' },
    })
    expect(world.commands(booking.id, 'payment.refund')).toEqual([])
    const cancelled = world.outbox().find((row) => row.messageType === 'booking.cancelled')
    expect(cancelled?.payload).toMatchObject({ refundAmount: { amountMinor: 0 } })
  })
})

describe('kompensasi', () => {
  test('refund gagal setelah supplier membatalkan: NEEDS_REVIEW tingkat error, bukan diam', async () => {
    const world = cancellationWorld()
    const booking = await cancelling(world)
    await world.supplierCancelled(booking)

    expect(await world.refundFailed(booking)).toBe('applied')

    expect(await world.booking(booking.id)).toMatchObject({
      status: 'NEEDS_REVIEW',
      review: { from: 'CANCELLING' },
    })
    expect(world.logs()).toContainEqual(
      expect.objectContaining({ level: ERROR_LEVEL, bookingId: booking.id }),
    )
    // Pembatalan supplier TIDAK dibalik: tidak ada perintah supplier lain
    // sesudah supplier.cancel yang satu itu.
    expect(world.sent(booking.id).filter((type) => type.startsWith('supplier.'))).toEqual([
      'supplier.confirm',
      'supplier.cancel',
    ])
    const failed = world.outbox().find((row) => row.messageType === 'booking.failed')
    expect(failed?.payload).toMatchObject({ stage: 'cancellation', requiresManualReview: true })
  })

  test('pembatalan supplier gagal: tidak ada refund yang dijalankan, pemesanan kembali aktif', async () => {
    const world = cancellationWorld()
    const booking = await cancelling(world)

    expect(await world.supplierCancelFailed(booking)).toBe('applied')

    expect(await world.booking(booking.id)).toMatchObject({
      status: 'CONFIRMED',
      supplierRef: SUPPLIER_REF,
    })
    expect(world.commands(booking.id, 'payment.refund')).toEqual([])
    expect(world.logs()).toContainEqual(
      expect.objectContaining({ level: ERROR_LEVEL, bookingId: booking.id }),
    )
  })

  test('status pembatalan supplier yang tidak pasti: NEEDS_REVIEW, tanpa refund, tanpa kembali aktif', async () => {
    const world = cancellationWorld()
    const booking = await cancelling(world)

    expect(await world.supplierCancelFailed(booking, 'uncertain')).toBe('applied')

    const reviewed = await world.booking(booking.id)
    expect(reviewed).toMatchObject({ status: 'NEEDS_REVIEW', review: { from: 'CANCELLING' } })
    // Peninjau membutuhkan booking reference dan nilai yang disetujui.
    expect(reviewed.review?.reason).toContain(SUPPLIER_REF)
    expect(reviewed.review?.reason).toContain('100%')
    expect(world.commands(booking.id, 'payment.refund')).toEqual([])
  })

  test('setelah supplier gagal, pengguna dapat mencoba membatalkan lagi', async () => {
    const world = cancellationWorld()
    const booking = await cancelling(world)
    await world.supplierCancelFailed(booking)

    const again = await world.cancel(booking)

    expect(again.kind).toBe('accepted')
    expect(world.commands(booking.id, 'supplier.cancel')).toHaveLength(2)
  })

  test('refund dengan nilai lain dari persetujuan diserahkan ke manusia', async () => {
    const world = cancellationWorld()
    const booking = await cancelling(world)
    await world.supplierCancelled(booking)

    await world.paymentRefunded(booking, { amount: money(1, 'IDR') })

    expect(await world.booking(booking.id)).toMatchObject({
      status: 'NEEDS_REVIEW',
      review: { from: 'CANCELLING' },
    })
  })

  test('kegagalan refund lain untuk pemesanan yang sama tidak menyentuh pembatalan', async () => {
    const world = cancellationWorld()
    const booking = await cancelling(world)
    await world.supplierCancelled(booking)

    const reaction = await world.refundFailed(booking, {
      refundRequestId: '0b9a8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d',
    })

    expect(reaction).toBe('ignored')
    expect((await world.booking(booking.id)).status).toBe('CANCELLING')
  })
})

describe('idempotensi', () => {
  test('permintaan pembatalan berulang tidak menghasilkan pembatalan kedua', async () => {
    const world = cancellationWorld()
    const booking = await cancelling(world)

    const again = await world.cancel(booking, PAID)

    expect(again).toMatchObject({ kind: 'accepted', booking: { status: 'CANCELLING' } })
    expect(world.commands(booking.id, 'supplier.cancel')).toHaveLength(1)
  })

  test('permintaan serentak hanya memindahkan pemesanan sekali', async () => {
    const world = cancellationWorld()
    const booking = await world.confirmed()

    const results = await Promise.all([
      world.cancel(booking, PAID),
      world.cancel(booking, PAID),
      world.cancel(booking, PAID),
    ])

    expect(results.map((result) => result.kind)).toEqual(['accepted', 'accepted', 'accepted'])
    expect(world.commands(booking.id, 'supplier.cancel')).toHaveLength(1)
  })

  test('pembatalan berulang tidak menghasilkan refund ganda', async () => {
    const world = cancellationWorld()
    const booking = await cancelling(world)
    const eventId = world.eventId('dup-cancel')

    // Jawaban supplier yang sama dua kali, jawaban supplier lain untuk
    // pembatalan yang sama, dan permintaan ulang pengguna.
    // Pesan yang sama yang dibaca ulang dijawab `ignored`, bukan `duplicate`:
    // pemesanan sudah tidak menunggu supplier, jadi tidak ada yang dicoba
    // ditulis — dan catatan pesan terkonsumsi baru diperiksa saat menulis.
    expect(await world.supplierCancelled(booking, { eventId })).toBe('applied')
    expect(await world.supplierCancelled(booking, { eventId })).toBe('ignored')
    expect(await world.supplierCancelled(booking)).toBe('ignored')
    await world.cancel(booking, PAID)

    const refunds = world.commands(booking.id, 'payment.refund')
    expect(refunds).toHaveLength(1)
  })

  test('pengenal permintaan refund sama pada setiap percobaan, dan berbeda dari refund kompensasi', () => {
    const id = cancellationRefundRequestId('b-1', 'p-1')

    expect(cancellationRefundRequestId('b-1', 'p-1')).toBe(id)
    expect(cancellationRefundRequestId('b-1', 'p-2')).not.toBe(id)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  test('jawaban untuk booking reference lain atau pembayaran lain diabaikan', async () => {
    const world = cancellationWorld()
    const booking = await cancelling(world)
    const { onSupplierCancelled } = await import('./on-replies.js')

    const otherRef = await onSupplierCancelled(world.deps, {
      eventId: world.eventId('other-ref'),
      bookingId: booking.id,
      supplierRef: 'SKY-BK-LAIN',
    })
    await world.supplierCancelled(booking)
    const otherPayment = await world.paymentRefunded(booking, {
      paymentId: '0b9a8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d',
    })

    expect([otherRef, otherPayment]).toEqual(['ignored', 'ignored'])
    expect((await world.booking(booking.id)).status).toBe('CANCELLING')
  })

  test('kalah balapan terus-menerus dilempar, bukan dijawab diam-diam', async () => {
    let losing = false
    const world = cancellationWorld({
      wrapSagas: (store) => ({
        ...store,
        commit: async (unit) => (losing ? 'stale' : await store.commit(unit)),
      }),
    })
    const booking = await world.confirmed()
    losing = true

    await expect(world.cancel(booking, PAID)).rejects.toThrow(/kalah balapan/)
  })

  test('jawaban untuk pemesanan yang tidak sedang dibatalkan diabaikan', async () => {
    // supplier.cancel juga kompensasi saga pemesanan (Step 19); jawabannya
    // terbit lewat topik yang sama.
    const world = cancellationWorld()
    const booking = await world.confirmed()

    expect(await world.supplierCancelled(booking)).toBe('ignored')
    expect(await world.supplierCancelFailed(booking)).toBe('ignored')
    expect(await world.refundFailed(booking)).toBe('ignored')
    expect((await world.booking(booking.id)).status).toBe('CONFIRMED')
  })
})

describe('persetujuan pengguna', () => {
  test('nilai yang berbeda dari pratinjau tidak dibatalkan, dan nilai baru dikembalikan', async () => {
    // Pengguna melihat 50% di pratinjau, ragu, dan tenggat 24 jam lewat
    // sebelum ia menekan tombol.
    const world = cancellationWorld()
    const booking = await world.confirmed()
    hoursBeforeCheckIn(world, 25)
    const seen = await world.preview(booking)
    hoursBeforeCheckIn(world, 23)

    const result = await world.cancel(
      booking,
      seen.kind === 'quoted' ? seen.quote.refund : undefined,
    )

    expect(result).toMatchObject({ kind: 'quote_changed', quote: { percent: 0 } })
    expect((await world.booking(booking.id)).status).toBe('CONFIRMED')
    expect(world.commands(booking.id, 'supplier.cancel')).toEqual([])
  })
})

describe('pemesanan yang tidak dapat dibatalkan', () => {
  test('pemesanan yang belum terkonfirmasi', async () => {
    const world = cancellationWorld()
    const held = await world.held()

    expect(await world.preview(held)).toEqual({ kind: 'not_cancellable', reason: 'not_confirmed' })
    expect(await world.cancel(held, PAID)).toEqual({
      kind: 'not_cancellable',
      reason: 'not_confirmed',
    })
  })

  test('menginap yang sudah dimulai di properti', async () => {
    const world = cancellationWorld()
    const booking = await world.confirmed()
    at(world, BALI_CHECK_IN_STARTS)

    expect(await world.preview(booking)).toEqual({
      kind: 'not_cancellable',
      reason: 'stay_started',
    })
  })

  test('properti yang tidak dikenal katalog tidak dihitung dengan zona tebakan', async () => {
    const world = cancellationWorld()
    const booking = await world.confirmed()
    world.properties.answer = { kind: 'not_found' }

    expect(await world.preview(booking)).toEqual({
      kind: 'not_cancellable',
      reason: 'time_zone_unknown',
    })
  })

  test('zona waktu yang tidak dikenal basis data IANA juga tidak ditebak', async () => {
    const world = cancellationWorld()
    const booking = await world.confirmed()
    world.properties.answer = { kind: 'found', timeZone: 'Asia/Atlantis' }

    expect(await world.preview(booking)).toEqual({
      kind: 'not_cancellable',
      reason: 'time_zone_unknown',
    })
  })

  test('katalog yang belum menjawab berarti coba lagi, tanpa perubahan', async () => {
    const world = cancellationWorld()
    const booking = await world.confirmed()
    world.properties.answer = { kind: 'unreachable' }

    expect(await world.cancel(booking, PAID)).toEqual({ kind: 'retry_later' })
    expect((await world.booking(booking.id)).status).toBe('CONFIRMED')
  })

  test('pemesanan sebelum Step 25 tanpa jadwal pengembalian', async () => {
    const world = cancellationWorld()
    const booking = await world.confirmed()
    const row = world.db.committed().bookings.get(booking.id)
    if (row === undefined) throw new Error('baris tidak ada')
    world.db.committed().bookings.set(booking.id, { ...row, refundSchedule: { tiers: null } })

    expect(await world.preview(booking)).toEqual({
      kind: 'not_cancellable',
      reason: 'policy_unknown',
    })
  })

  test.each([
    ['sedang dibatalkan', 'in_progress'],
    ['sudah dibatalkan', 'already_cancelled'],
  ])('pemesanan yang %s', async (_name, reason) => {
    const world = cancellationWorld()
    const booking = await cancelling(world)
    if (reason === 'already_cancelled') {
      await world.supplierCancelled(booking)
      await world.paymentRefunded(booking)
    }

    expect(await world.preview(booking)).toEqual({ kind: 'not_cancellable', reason })
  })

  test('pembatalan yang diserahkan ke manusia dianggap masih berjalan', async () => {
    const world = cancellationWorld()
    const booking = await cancelling(world)
    await world.supplierCancelled(booking)
    await world.refundFailed(booking)

    expect(await world.preview(booking)).toEqual({ kind: 'not_cancellable', reason: 'in_progress' })
    expect(await world.cancel(booking, PAID)).toMatchObject({ kind: 'accepted' })
  })

  test('pemesanan orang lain tidak ditemukan', async () => {
    const world = cancellationWorld()
    const booking = await world.confirmed()
    const { previewCancellation, requestCancellation } = await import('./request.js')
    const stranger = { userId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', bookingId: booking.id }

    expect(await previewCancellation(world.deps, stranger)).toEqual({ kind: 'not_found' })
    expect(await requestCancellation(world.deps, { ...stranger, expectedRefund: PAID })).toEqual({
      kind: 'not_found',
    })
  })
})

describe('jawaban yang tidak datang', () => {
  test('supplier tidak menjawab: NEEDS_REVIEW tanpa refund dan tanpa kembali ke CONFIRMED', async () => {
    const world = cancellationWorld()
    const booking = await cancelling(world)
    world.advance(world.deps.sagaPolicy.confirmTimeoutMs + 1)

    expect(await sweepCancellations(world.deps)).toEqual({ reviewed: 1, skipped: 0 })

    expect(await world.booking(booking.id)).toMatchObject({
      status: 'NEEDS_REVIEW',
      review: { from: 'CANCELLING', reason: expect.stringContaining('supplier') },
    })
    expect(world.commands(booking.id, 'payment.refund')).toEqual([])
  })

  test('refund tidak terkonfirmasi: NEEDS_REVIEW', async () => {
    const world = cancellationWorld()
    const booking = await cancelling(world)
    await world.supplierCancelled(booking)
    world.advance(world.deps.sagaPolicy.awaitRefundTimeoutMs + 1)

    await sweepCancellations(world.deps)

    expect(await world.booking(booking.id)).toMatchObject({
      status: 'NEEDS_REVIEW',
      review: { reason: expect.stringContaining('refund') },
    })
  })

  test('pembatalan yang belum lewat batas waktunya tidak disentuh', async () => {
    const world = cancellationWorld()
    const booking = await cancelling(world)

    expect(await sweepCancellations(world.deps)).toEqual({ reviewed: 0, skipped: 0 })
    expect((await world.booking(booking.id)).status).toBe('CANCELLING')
  })

  test('jawaban yang menang balapan dengan penyapu tidak ditimpa', async () => {
    const world = cancellationWorld()
    const booking = await cancelling(world)
    world.advance(world.deps.sagaPolicy.confirmTimeoutMs + 1)
    const overdue = await world.deps.bookings.findOverdueCancellations(world.now(), 10)

    // Jawaban supplier tiba di antara kueri penyapu dan keputusannya.
    await world.supplierCancelled(booking)
    const { sweepCancellations: sweep } = await import('./sweep.js')
    const stale = {
      ...world.deps,
      bookings: {
        ...world.deps.bookings,
        findOverdueCancellations: async () => await Promise.resolve(overdue),
      },
    }

    expect(await sweep(stale)).toEqual({ reviewed: 0, skipped: 1 })
    expect((await world.booking(booking.id)).status).toBe('CANCELLING')
  })
})
