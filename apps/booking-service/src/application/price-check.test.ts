import { money } from '@tbe/money'
import { describe, expect, test } from 'vitest'
import {
  harness,
  OTHER_USER,
  priceCheckRequest,
  recordingLogger,
  sellQuoteFor,
  USER,
} from '../testing/fakes.js'
import { acceptPriceChange, checkPrice, startPriceCheck } from './price-check.js'

function checked(result: Awaited<ReturnType<typeof startPriceCheck>>) {
  if (result.kind !== 'checked') throw new Error(`diharapkan checked, diperoleh ${result.kind}`)
  return result.booking
}

describe('price check langsung ke supplier (FR-13)', () => {
  test('harga yang sama dengan yang ditampilkan menghasilkan PRICE_CHECKED terverifikasi', async () => {
    const world = harness()

    const booking = checked(await startPriceCheck(world.deps, priceCheckRequest()))

    expect(booking.status).toBe('PRICE_CHECKED')
    expect(booking.status === 'PRICE_CHECKED' && booking.priceCheck.kind).toBe('verified')
    // Harga jual dihitung dari harga supplier lewat pricing-service, dengan
    // kota pemesanan sebagai cakupan markup.
    expect(world.pricing.requests).toEqual([
      {
        ref: booking.id,
        supplier: 'SKY',
        city: 'Denpasar',
        supplierTotal: money(2_000_000, 'IDR'),
      },
    ])
  })

  /**
   * Definisi Selesai "price check selalu langsung ke supplier, tidak pernah
   * dari cache". Tiga price check berturut-turut untuk pemesanan yang sama,
   * dalam detik yang sama, tanpa satu pun perubahan di antaranya: tiga
   * panggilan ke supplier. Jalur yang menyimpan hasil sebelumnya — di mana pun
   * — akan menghasilkan satu.
   */
  test('setiap price check adalah satu panggilan ke supplier, termasuk yang diulang', async () => {
    const world = harness()

    await startPriceCheck(world.deps, priceCheckRequest())
    await startPriceCheck(world.deps, priceCheckRequest())
    await startPriceCheck(world.deps, priceCheckRequest())

    expect(world.suppliers.priceChecks).toHaveLength(3)
    expect(world.suppliers.priceChecks[0]).toEqual({
      supplier: 'SKY',
      supplierRatePlanId: 'SKY-RP-DLX-BB',
      checkIn: '2026-11-10',
      checkOut: '2026-11-12',
    })
  })

  test('harga supplier yang berubah di antara dua price check terlihat pada yang kedua', async () => {
    const world = harness()
    await startPriceCheck(world.deps, priceCheckRequest())

    world.suppliers.supplierTotal = money(2_100_000, 'IDR')
    const booking = checked(await startPriceCheck(world.deps, priceCheckRequest()))

    expect(booking.status === 'PRICE_CHECKED' && booking.priceCheck.kind).toBe('changed')
  })
})

describe('kebijakan pembatalan diverifikasi ke supplier (Step 25)', () => {
  test('kebijakan dari supplier menggantikan yang dikirim peramban', async () => {
    // Peramban mengirim "refundable, gratis 3 hari"; supplier menjawab rate
    // ini non-refundable. Tanpa verifikasi, pengguna yang memesan rate murah
    // non-refundable dapat membatalkannya dengan refund penuh.
    const world = harness()
    world.suppliers.supplierPolicy = { refundable: false }

    const booking = checked(await startPriceCheck(world.deps, priceCheckRequest()))

    expect(booking.terms?.cancellationPolicy).toEqual({ refundable: false })
    expect(booking.refundSchedule?.tiers).toEqual([{ minHoursBefore: 0, percent: 0 }])
  })

  test('perbedaan dengan kebijakan yang dikirim peramban dicatat', async () => {
    const recorder = recordingLogger()
    const world = harness({ logger: recorder.logger })
    world.suppliers.supplierPolicy = { refundable: false }

    await startPriceCheck(world.deps, priceCheckRequest())

    expect(recorder.entries()).toContainEqual(
      expect.objectContaining({ level: 'warn', msg: expect.stringContaining('kebijakan') }),
    )
  })

  test('tenggat gratis yang berbeda juga dicatat sebagai perbedaan', async () => {
    const recorder = recordingLogger()
    const world = harness({ logger: recorder.logger })
    world.suppliers.supplierPolicy = { refundable: true, freeCancellationDays: 5 }

    const booking = checked(await startPriceCheck(world.deps, priceCheckRequest()))

    expect(booking.refundSchedule?.tiers[0]).toEqual({ minHoursBefore: 120, percent: 100 })
    expect(recorder.entries().some((entry) => entry.level === 'warn')).toBe(true)
  })

  test('kebijakan yang sama dengan peramban tidak dicatat', async () => {
    const recorder = recordingLogger()
    const world = harness({ logger: recorder.logger })

    await startPriceCheck(world.deps, priceCheckRequest())

    expect(recorder.entries().filter((entry) => entry.level === 'warn')).toEqual([])
  })

  test('jadwal tersimpan juga ketika harganya berubah', async () => {
    const world = harness()
    world.suppliers.supplierTotal = money(2_100_000, 'IDR')

    const booking = checked(await startPriceCheck(world.deps, priceCheckRequest()))

    expect(booking.status === 'PRICE_CHECKED' && booking.priceCheck.kind).toBe('changed')
    expect(booking.refundSchedule?.tiers[0]).toEqual({ minHoursBefore: 72, percent: 100 })
  })
})

describe('harga berubah menghentikan alur (FR-14, US-02)', () => {
  test('harga berbeda berakhir menunggu persetujuan dengan harga lama tetap disetujui', async () => {
    const world = harness()
    world.suppliers.supplierTotal = money(2_100_000, 'IDR')

    const booking = checked(await startPriceCheck(world.deps, priceCheckRequest()))

    expect(booking.status === 'PRICE_CHECKED' && booking.priceCheck.kind).toBe('changed')
    expect(booking.price.total).toEqual(money(2_442_000, 'IDR'))
  })

  test('peristiwa PriceChanged tercatat dengan harga lama dan baru', async () => {
    const world = harness()
    world.suppliers.supplierTotal = money(2_100_000, 'IDR')

    await startPriceCheck(world.deps, priceCheckRequest())

    expect(world.db.committed().events.map((event) => event.eventType)).toEqual([
      'BookingCreated',
      'PriceChanged',
    ])
    expect(world.db.committed().events[1]?.payload).toEqual({
      previousAmount: { amountMinor: 2_442_000, currency: 'IDR' },
      newAmount: { amountMinor: 2_564_100, currency: 'IDR' },
      // Jenjang dari kebijakan supplier ikut tercatat (Step 25).
      refundTiers: [
        { minHoursBefore: 72, percent: 100 },
        { minHoursBefore: 24, percent: 50 },
        { minHoursBefore: 0, percent: 0 },
      ],
    })
  })

  test('price check ulang saat menunggu persetujuan tidak memanggil supplier', async () => {
    const world = harness()
    world.suppliers.supplierTotal = money(2_100_000, 'IDR')
    await startPriceCheck(world.deps, priceCheckRequest())

    await startPriceCheck(world.deps, priceCheckRequest())

    // Menunggu persetujuan pengguna: tidak ada price check yang boleh
    // mengubahnya, jadi tidak ada gunanya bertanya ke supplier.
    expect(world.suppliers.priceChecks).toHaveLength(1)
  })

  test('persetujuan menghasilkan price check ULANG, dan harga baru menjadi harga disetujui', async () => {
    const world = harness()
    world.suppliers.supplierTotal = money(2_100_000, 'IDR')
    const booking = checked(await startPriceCheck(world.deps, priceCheckRequest()))

    const result = await acceptPriceChange(world.deps, { userId: USER, bookingId: booking.id })

    const accepted = checked(result)
    expect(world.suppliers.priceChecks).toHaveLength(2)
    expect(accepted.status === 'PRICE_CHECKED' && accepted.priceCheck.kind).toBe('verified')
    expect(accepted.price.total).toEqual(money(2_564_100, 'IDR'))
  })

  test('harga yang berubah LAGI setelah persetujuan kembali menunggu persetujuan', async () => {
    const world = harness()
    world.suppliers.supplierTotal = money(2_100_000, 'IDR')
    const booking = checked(await startPriceCheck(world.deps, priceCheckRequest()))
    world.suppliers.supplierTotal = money(2_200_000, 'IDR')

    const again = checked(
      await acceptPriceChange(world.deps, { userId: USER, bookingId: booking.id }),
    )

    expect(again.status === 'PRICE_CHECKED' && again.priceCheck.kind).toBe('changed')
    // Yang disetujui adalah harga yang pengguna LIHAT saat menyetujui, bukan
    // harga yang muncul sesudahnya.
    expect(again.price.total).toEqual(money(2_564_100, 'IDR'))
  })

  test('persetujuan yang DIULANG setelah price check ulangnya gagal: diverifikasi, bukan ditolak', async () => {
    // Step 22: seribu persetujuan serentak. Persetujuan tersimpan, price check
    // ulangnya gagal (basis data penuh → 503), dan klien mengulang
    // persetujuan yang SAMA. Versi sebelumnya menolaknya 409
    // BOOKING_RULE_VIOLATION — pengguna yang sudah menyetujui terjebak.
    const world = harness()
    world.suppliers.supplierTotal = money(2_100_000, 'IDR')
    const booking = checked(await startPriceCheck(world.deps, priceCheckRequest()))
    world.suppliers.nextPrice({ kind: 'unreachable' })
    const first = await acceptPriceChange(world.deps, { userId: USER, bookingId: booking.id })
    expect(first.kind).toBe('retry_later')

    const retried = checked(
      await acceptPriceChange(world.deps, { userId: USER, bookingId: booking.id }),
    )

    expect(retried.status === 'PRICE_CHECKED' && retried.priceCheck.kind).toBe('verified')
    expect(retried.price.total).toEqual(money(2_564_100, 'IDR'))
  })

  test('persetujuan tanpa perubahan harga ditolak domain', async () => {
    const world = harness()
    const booking = checked(await startPriceCheck(world.deps, priceCheckRequest()))

    const result = await acceptPriceChange(world.deps, { userId: USER, bookingId: booking.id })

    expect(result.kind).toBe('refused')
  })

  test('persetujuan atas pemesanan orang lain dijawab seperti pemesanan yang tidak ada', async () => {
    const world = harness()
    const booking = checked(await startPriceCheck(world.deps, priceCheckRequest()))

    const result = await acceptPriceChange(world.deps, {
      userId: OTHER_USER,
      bookingId: booking.id,
    })

    expect(result).toEqual({ kind: 'not_found' })
  })
})

describe('supplier tidak tersedia', () => {
  test('rate plan yang habis membatalkan pemesanan, bukan menggantungkannya', async () => {
    const world = harness()
    world.suppliers.nextPrice({ kind: 'rejected', reason: 'sold_out' })

    const booking = checked(await startPriceCheck(world.deps, priceCheckRequest()))

    expect(booking.status).toBe('CANCELLED')
    expect(booking.status === 'CANCELLED' && booking.cancellation).toBe('supplier_rejected')
  })

  test('supplier yang belum menjawab tidak mengubah pemesanan', async () => {
    const world = harness()
    world.suppliers.nextPrice({ kind: 'unreachable' })

    const result = await startPriceCheck(world.deps, priceCheckRequest())

    expect(result.kind).toBe('retry_later')
    if (result.kind !== 'retry_later') return
    expect(result.booking.status).toBe('DRAFT')
  })

  test('harga jual yang tidak konsisten dari pricing-service tidak dipakai', async () => {
    const world = harness()
    world.pricing.nextQuote({
      ...sellQuoteFor(money(2_000_000, 'IDR')),
      total: money(2_442_001, 'IDR'),
    })

    const result = await startPriceCheck(world.deps, priceCheckRequest())

    expect(result.kind).toBe('retry_later')
    if (result.kind !== 'retry_later') return
    expect(result.booking.status).toBe('DRAFT')
  })

  test('pricing-service yang gagal menghitung tidak menyetujui harga supplier', async () => {
    const world = harness()
    world.pricing.failNext()

    const result = await startPriceCheck(world.deps, priceCheckRequest())

    expect(result.kind).toBe('retry_later')
  })

  test('pemesanan yang tidak dapat diverifikasi dikembalikan tanpa memanggil supplier', async () => {
    const world = harness()
    world.suppliers.nextPrice({ kind: 'rejected', reason: 'not_found' })
    const cancelled = checked(await startPriceCheck(world.deps, priceCheckRequest()))

    const again = await checkPrice(world.deps, cancelled)

    expect(again).toEqual({ kind: 'checked', booking: cancelled })
    expect(world.suppliers.priceChecks).toHaveLength(1)
  })
})

describe('idempotensi (FR-18)', () => {
  test('kunci yang sama tidak membuat pemesanan kedua', async () => {
    const world = harness()

    const first = checked(await startPriceCheck(world.deps, priceCheckRequest()))
    const second = checked(await startPriceCheck(world.deps, priceCheckRequest()))

    expect(second.id).toBe(first.id)
    expect(world.db.committed().bookings.size).toBe(1)
  })

  /**
   * Dua permintaan SERENTAK, bukan berurutan. Keduanya tidak menemukan
   * pemesanan, keduanya menyisipkan; batasan UNIK `(user_id, idempotency_key)`
   * menolak satu, dan yang ditolak menerima pemesanan pemenang.
   */
  test('dua permintaan serentak dengan kunci yang sama menghasilkan satu pemesanan', async () => {
    const world = harness()

    const [a, b] = await Promise.all([
      startPriceCheck(world.deps, priceCheckRequest()),
      startPriceCheck(world.deps, priceCheckRequest()),
    ])

    expect(checked(a).id).toBe(checked(b).id)
    expect(world.db.committed().bookings.size).toBe(1)
    expect(checked(b).status).toBe('PRICE_CHECKED')
  })

  test('kunci yang sama untuk rate plan lain ditolak, bukan dijawab dengan pemesanan pertama', async () => {
    const world = harness()
    await startPriceCheck(world.deps, priceCheckRequest())

    const other = await startPriceCheck(world.deps, {
      ...priceCheckRequest(),
      ratePlanRef: 'SKY-RP-STD',
    })

    expect(other.kind).toBe('key_reused')
    expect(world.db.committed().bookings.size).toBe(1)
  })

  test('pengguna lain dengan kunci yang sama memperoleh pemesanannya sendiri', async () => {
    const world = harness()

    const mine = checked(await startPriceCheck(world.deps, priceCheckRequest()))
    const theirs = checked(
      await startPriceCheck(world.deps, priceCheckRequest({ userId: OTHER_USER })),
    )

    expect(theirs.id).not.toBe(mine.id)
  })
})

describe('ketentuan tawaran (Step 23)', () => {
  test('ketentuan tawaran disimpan bersama pemesanan sebagai bahan e-voucher', async () => {
    const world = harness()

    const result = await startPriceCheck(world.deps, priceCheckRequest())

    expect(result.kind).toBe('checked')
    const [stored] = [...world.db.committed().bookings.values()]
    expect(stored?.offerTerms).toEqual({ terms: priceCheckRequest().offer })
  })
})

describe('masukan tidak sah', () => {
  test.each([
    ['kunci idempotensi', { idempotencyKey: 'x' }],
    ['tanggal menginap', { checkOut: '2026-11-10' }],
    ['tamu', { guest: { fullName: '', email: 'sari@example.com', count: 2 } }],
    ['harga yang ditampilkan', { displayedTotal: money(0, 'IDR') }],
    ['kota', { city: ' ' }],
    ['ketentuan tawaran', { offer: { ...priceCheckRequest().offer, roomTypeName: '' } }],
  ])('%s yang tidak sah ditolak tanpa membuat pemesanan', async (_name, override) => {
    const world = harness()

    const result = await startPriceCheck(world.deps, { ...priceCheckRequest(), ...override })

    expect(result.kind).toBe('invalid')
    expect(world.db.committed().bookings.size).toBe(0)
    expect(world.suppliers.priceChecks).toHaveLength(0)
  })
})
