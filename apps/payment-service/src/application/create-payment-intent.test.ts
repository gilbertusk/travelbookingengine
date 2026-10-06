import { money } from '@tbe/money'
import { describe, expect, test } from 'vitest'
import {
  LOG_LEVELS,
  TEST_AMOUNT,
  TEST_BOOKING_ID,
  harness,
  scriptedGateway,
} from '../testing/fakes.js'
import { createPaymentIntent, type CreateIntentInput } from './create-payment-intent.js'

function request(overrides: Partial<CreateIntentInput> = {}): CreateIntentInput {
  return {
    bookingId: TEST_BOOKING_ID,
    idempotencyKey: 'bkg-1:attempt-1',
    amount: TEST_AMOUNT,
    ...overrides,
  }
}

describe('nilai yang ditagih', () => {
  test('pembayaran dibuat dengan nilai dari peristiwa pemesanan', async () => {
    const world = harness()

    const result = await createPaymentIntent(world.deps, request())

    expect(result.kind).toBe('created')
    if (result.kind !== 'created') return

    expect(result.payment.status).toBe('PENDING')
    expect(result.payment.amount).toEqual(TEST_AMOUNT)
    expect(world.gateway.charges[0]?.amount).toEqual(TEST_AMOUNT)
  })

  /**
   * G2: pengguna tidak pernah dibebani nilai selain yang terakhir disetujuinya.
   *
   * Nilai pada permintaan adalah yang DILIHAT pengguna, dan ia hanya dipakai
   * sebagai pembanding. Yang ditagih selalu nilai dari peristiwa pemesanan.
   * Kalau keduanya berbeda, halaman pengguna sudah basi — dan yang benar adalah
   * menghentikan alurnya, bukan menagih salah satu dari keduanya.
   */
  test('nilai yang berbeda dari harga yang disetujui ditolak', async () => {
    const world = harness()

    const result = await createPaymentIntent(world.deps, request({ amount: money(999_000, 'IDR') }))

    expect(result.kind).toBe('rejected')
    if (result.kind !== 'rejected') return
    expect(result.why).toBe('amount_not_approved')

    // Tidak ada pembayaran yang dibuat, dan penyedia tidak pernah dihubungi.
    expect(world.payments.rows.size).toBe(0)
    expect(world.gateway.charges).toHaveLength(0)
  })

  test('penolakan nilai dicatat beserta kedua nilainya', async () => {
    const world = harness()

    await createPaymentIntent(world.deps, request({ amount: money(999_000, 'IDR') }))

    const warning = world.lines.find((line) => line.level === LOG_LEVELS.warn)

    expect(warning?.approvedMinor).toBe(1_250_000)
    expect(warning?.requestedMinor).toBe(999_000)
  })

  test('mata uang yang berbeda ditolak, bukan dikonversi', async () => {
    const world = harness()

    const result = await createPaymentIntent(world.deps, request({ amount: money(80, 'USD') }))

    expect(result.kind).toBe('rejected')
    if (result.kind !== 'rejected') return
    expect(result.why).toBe('amount_not_approved')
  })

  /**
   * Menolak alih-alih mempercayai pemanggil. Pemesanan yang belum punya
   * peristiwa apa pun berarti kita tidak tahu berapa yang disetujui pengguna,
   * dan menagih nilai yang dikirim pemanggil pada keadaan itu berarti nilai yang
   * ditagih ditentukan oleh peminta pembayaran.
   */
  test('pemesanan tanpa harga yang tercatat ditolak, bukan memakai nilai permintaan', async () => {
    const world = harness()
    world.payables.rows.clear()

    const result = await createPaymentIntent(world.deps, request())

    expect(result.kind).toBe('rejected')
    if (result.kind !== 'rejected') return
    expect(result.why).toBe('amount_unknown')
    expect(world.gateway.charges).toHaveLength(0)
  })

  test('harga yang sudah berubah membuat hanya nilai baru yang diterima', async () => {
    const world = harness({
      payable: {
        bookingId: TEST_BOOKING_ID,
        amount: money(1_400_000, 'IDR'),
        source: 'booking.price_changed',
        observedAt: new Date('2026-09-25T01:30:00.000Z'),
      },
    })

    const stale = await createPaymentIntent(world.deps, request({ amount: TEST_AMOUNT }))
    expect(stale.kind).toBe('rejected')

    const fresh = await createPaymentIntent(
      world.deps,
      request({ amount: money(1_400_000, 'IDR') }),
    )

    expect(fresh.kind).toBe('created')
    expect(world.gateway.charges[0]?.amount).toEqual(money(1_400_000, 'IDR'))
  })
})

describe('idempotensi permintaan (FR-18)', () => {
  test('permintaan identik kedua tidak membuat pembayaran kedua', async () => {
    const world = harness()

    const first = await createPaymentIntent(world.deps, request())
    const second = await createPaymentIntent(world.deps, request())

    expect(first.kind).toBe('created')
    expect(second.kind).toBe('resumed')
    expect(world.payments.rows.size).toBe(1)

    if (first.kind !== 'created' || second.kind !== 'resumed') return

    // Pembayaran yang SAMA, jadi order_id di sisi penyedia juga sama — dan itulah
    // yang membuat permintaan ulang tidak menghasilkan transaksi kedua di sana.
    expect(second.payment.id).toBe(first.payment.id)
    expect(world.gateway.charges.map((charge) => charge.paymentId)).toEqual([
      first.payment.id,
      first.payment.id,
    ])
  })

  test('dua permintaan serentak dengan kunci sama menghasilkan satu pembayaran', async () => {
    const world = harness()

    const results = await Promise.all([
      createPaymentIntent(world.deps, request()),
      createPaymentIntent(world.deps, request()),
    ])

    expect(world.payments.rows.size).toBe(1)
    expect(results.filter((result) => result.kind === 'created')).toHaveLength(1)
    expect(results.filter((result) => result.kind === 'resumed')).toHaveLength(1)
  })

  test('pembayaran yang sudah berhasil tidak dikirim ulang ke penyedia', async () => {
    const world = harness()
    const created = await createPaymentIntent(world.deps, request())
    if (created.kind !== 'created') throw new Error('persiapan gagal')

    const settled = {
      ...created.payment,
      status: 'SUCCEEDED' as const,
      gatewayRef: 'tx-1',
      refunds: [],
    }
    await world.payments.update(settled)
    const chargesBefore = world.gateway.charges.length

    const again = await createPaymentIntent(world.deps, request())

    expect(again.kind).toBe('existing')
    // Menagih ulang pembayaran yang sudah berhasil adalah penagihan ganda.
    expect(world.gateway.charges).toHaveLength(chargesBefore)
  })

  test('kunci idempotensi berbeda untuk pemesanan sama membuat pembayaran baru', async () => {
    const world = harness()

    await createPaymentIntent(world.deps, request())
    const retry = await createPaymentIntent(
      world.deps,
      request({ idempotencyKey: 'bkg-1:attempt-2' }),
    )

    // Pembayaran yang gagal boleh disusul percobaan baru — karena itu bookingId
    // TIDAK unik di skemanya. Lihat catatan pada prisma/schema.prisma.
    expect(retry.kind).toBe('created')
    expect(world.payments.rows.size).toBe(2)
  })
})

describe('kegagalan penyedia', () => {
  test('penolakan penyedia dilaporkan dan pembayaran tetap tersimpan', async () => {
    const world = harness({
      gateway: scriptedGateway({ charge: [{ kind: 'rejected', reason: 'kartu ditolak' }] }),
    })

    const result = await createPaymentIntent(world.deps, request())

    expect(result.kind).toBe('rejected')
    if (result.kind !== 'rejected') return
    expect(result.why).toBe('gateway_rejected')

    // Barisnya tetap ada, dan tetap PENDING. Menghapusnya akan membuat kunci
    // idempotensi bebas lagi, dan permintaan ulang membuat baris kedua.
    expect(world.payments.rows.size).toBe(1)
  })

  test('penyedia yang tidak dapat dihubungi dapat dicoba ulang dengan kunci yang sama', async () => {
    const world = harness({
      gateway: scriptedGateway({
        charge: [
          { kind: 'unavailable' },
          {
            kind: 'created',
            redirectUrl: 'https://sandbox.example/redirect',
            providerRef: 'snap-2',
          },
        ],
      }),
    })

    const first = await createPaymentIntent(world.deps, request())
    expect(first.kind).toBe('rejected')
    if (first.kind !== 'rejected') return
    expect(first.why).toBe('gateway_unavailable')

    // Percobaan kedua memakai kunci yang sama: pembayaran tidak dibuat ulang,
    // tetapi penagihannya diulang. Tanpa jalur ini, pembayaran yang gagal
    // dihubungi akan terkunci selamanya oleh kunci idempotensinya sendiri.
    const second = await createPaymentIntent(world.deps, request())

    expect(second.kind).toBe('resumed')
    if (second.kind !== 'resumed') return
    expect(second.redirectUrl).toBe('https://sandbox.example/redirect')
    // Token Snap untuk mode popup — rujukan penyedia yang sama, bukan token baru.
    expect(second.snapToken).toBe('snap-2')
    expect(world.payments.rows.size).toBe(1)
  })
})

describe('urutan penulisan dan pemanggilan', () => {
  /**
   * Pembayaran disimpan LEBIH DULU, penyedia dihubungi sesudahnya.
   *
   * Urutan sebaliknya berarti transaksi sudah ada di Midtrans ketika penyisipan
   * ditolak batasan UNIK — dan transaksi penyedia yang tidak punya baris di
   * sisi kita adalah uang yang tidak dapat dipertanggungjawabkan.
   */
  test('pembayaran tersimpan sebelum penyedia dihubungi', async () => {
    const world = harness()

    await createPaymentIntent(world.deps, request())

    const paymentId = world.ids.issued[0] ?? ''
    expect(world.effects).toEqual([`insert:${paymentId}`, `gateway:charge:${paymentId}`])
  })

  test('pembayaran tanpa peristiwa harga tidak pernah menyentuh penyedia', async () => {
    const world = harness()
    world.payables.rows.clear()

    await createPaymentIntent(world.deps, request())

    expect(world.gateway.charges).toHaveLength(0)
    expect(world.payments.rows.size).toBe(0)
  })
})
