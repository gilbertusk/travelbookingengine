import { EVENT_PAYLOADS } from '@tbe/event-contracts'
import type { Money } from '@tbe/money'
import { describe, expect, test } from 'vitest'
import {
  draft,
  draftChange,
  inState,
  minutesAfter,
  samplePrice,
  validCommand,
} from '../testing/builders.js'
import { CANCELLATION_REASONS, SUPPLIER_CODES, type Booking } from '../domain/booking.js'
import type { BookingCommand } from '../domain/commands.js'
import { BOOKING_EVENT_TYPES, type BookingEvent } from '../domain/events.js'
import { applyCommand } from '../domain/transitions.js'
import { toContractEvent } from './contract-payloads.js'

/**
 * Peristiwa domain membawa seluruh yang dituntut kontrak Kafka-nya.
 *
 * Diuji dengan MENGURAI hasil pemetaan memakai skema Zod dari
 * @tbe/event-contracts — skema yang sama yang dipakai pembungkus consumer di
 * payment-service untuk menolak pesan cacat. Bidang yang terlupa, tipe yang
 * salah, atau kode supplier yang tidak dikenal kontrak gagal di sini, bukan di
 * consumer pertama yang membacanya.
 */

/** Menjalankan satu perintah dan mengembalikan pemesanan beserta peristiwanya. */
function run(booking: Booking, command: BookingCommand): { booking: Booking; event: BookingEvent } {
  const result = applyCommand(booking, command)
  if (!result.ok) throw new Error(`perintah ${command.type} ditolak: ${result.error.message}`)

  return result.value
}

/** Satu contoh untuk setiap jenis peristiwa domain. */
function oneOfEach(): readonly BookingEvent[] {
  const created = draftChange().event
  const changed = run(draft(), {
    type: 'verifyPrice',
    at: minutesAfter(draft().updatedAt, 1),
    verified: samplePrice(1_100_000),
  })
  const accepted = run(changed.booking, validCommand(changed.booking, 'acceptPrice'))

  const produce = (status: Parameters<typeof inState>[0], type: BookingCommand['type']) => {
    const booking = inState(status)
    return run(booking, validCommand(booking, type)).event
  }

  return [
    created,
    produce('DRAFT', 'verifyPrice'),
    changed.event,
    accepted.event,
    produce('PRICE_CHECKED', 'hold'),
    produce('HELD', 'expireHold'),
    produce('HELD', 'recordPayment'),
    produce('PAID', 'confirm'),
    produce('PAID', 'fail'),
    produce('FAILED', 'recordRefund'),
    produce('HELD', 'cancel'),
    produce('PAID', 'requireReview'),
    produce('FAILED', 'requireReview'),
  ]
}

describe('payload kontrak dapat diurai skemanya', () => {
  test('contoh mencakup setiap jenis peristiwa domain', () => {
    expect(new Set(oneOfEach().map((event) => event.type))).toEqual(new Set(BOOKING_EVENT_TYPES))
  })

  test.each(oneOfEach().map((event) => [event.type, event] as const))(
    '%s dipetakan ke payload yang lolos skemanya',
    (_type, event) => {
      const contract = toContractEvent(event)
      if (contract === undefined) return

      const parsed = EVENT_PAYLOADS[contract.type].safeParse(contract.payload)

      expect(parsed.error?.issues ?? []).toEqual([])
    },
  )

  test('hanya peristiwa audit internal yang tidak punya pasangan kontrak', () => {
    const unmapped = oneOfEach()
      .filter((event) => toContractEvent(event) === undefined)
      .map((event) => event.type)

    expect(new Set(unmapped)).toEqual(
      new Set(['PriceVerified', 'PriceAccepted', 'PaymentRecorded', 'BookingRefunded']),
    )
  })

  test.each(SUPPLIER_CODES)('kode supplier %s dikenal kontrak booking.created', (supplier) => {
    const created = { ...draftChange().event, supplier }
    const contract = toContractEvent(created)

    expect(EVENT_PAYLOADS['booking.created'].safeParse(contract?.payload).success).toBe(true)
  })

  test.each(CANCELLATION_REASONS)('alasan pembatalan %s dikenal kontrak', (reason) => {
    const booking = inState('HELD')
    const { event } = run(booking, { type: 'cancel', at: booking.updatedAt, reason })

    expect(
      EVENT_PAYLOADS['booking.cancelled'].safeParse(toContractEvent(event)?.payload).success,
    ).toBe(true)
  })

  test('hold kedaluwarsa diumumkan sebagai pembatalan hold_expired', () => {
    const booking = inState('HELD')
    const { event } = run(booking, validCommand(booking, 'expireHold'))

    expect(toContractEvent(event)).toMatchObject({
      type: 'booking.cancelled',
      payload: { reason: 'hold_expired' },
    })
  })

  test.each([
    ['PAID', 'supplier_confirm'],
    ['FAILED', 'payment'],
  ] as const)('peninjauan dari %s diumumkan pada tahap %s', (from, stage) => {
    const booking = inState(from)
    const { event } = run(booking, validCommand(booking, 'requireReview'))

    expect(toContractEvent(event)).toMatchObject({
      type: 'booking.failed',
      payload: { stage, requiresManualReview: true },
    })
  })

  test('tanggal menginap tetap tanggal kalender, bukan titik waktu', () => {
    const contract = toContractEvent(draftChange().event)

    expect(contract?.payload).toMatchObject({ checkIn: '2026-11-10', checkOut: '2026-11-12' })
  })
})

/**
 * Kesepakatan dengan payment-service (Step 18).
 *
 * payment-service menetapkan nilai yang boleh ditagih dari peristiwa TERAKHIR
 * di antara `booking.created` (bidang `amount`) dan `booking.price_changed`
 * (bidang `newAmount`) — lihat apps/payment-service/src/messaging/
 * booking-events.ts. Fungsi di bawah meniru aturan itu atas aliran peristiwa
 * yang dihasilkan domain ini.
 *
 * Yang dibuktikan: setiap kali pemesanan mencapai HELD — satu-satunya keadaan
 * tempat pembayaran boleh dibuat — nilai yang diyakini payment-service SAMA
 * dengan harga yang disetujui pengguna. Kalau berbeda, pembayaran yang sah
 * akan ditolak payment-service, atau lebih buruk, nilai yang tidak disetujui
 * akan ditagih.
 */
function payableAccordingToPaymentService(events: readonly BookingEvent[]): Money | undefined {
  return events.reduce<Money | undefined>((payable, event) => {
    const contract = toContractEvent(event)
    if (contract?.type === 'booking.created') return contract.payload.amount
    if (contract?.type === 'booking.price_changed') return contract.payload.newAmount

    return payable
  }, undefined)
}

function flow(verifiedPrices: readonly number[]): { held: Booking; events: BookingEvent[] } {
  const { booking: start, event: created } = draftChange()
  const events: BookingEvent[] = [created]
  let booking: Booking = start

  for (const nightly of verifiedPrices) {
    const checked = run(booking, {
      type: 'verifyPrice',
      at: minutesAfter(booking.updatedAt, 1),
      verified: samplePrice(nightly),
    })
    events.push(checked.event)
    booking = checked.booking

    if (checked.event.type === 'PriceChanged') {
      const accepted = run(booking, validCommand(booking, 'acceptPrice'))
      events.push(accepted.event)
      booking = accepted.booking
    }
  }

  const held = run(booking, validCommand(booking, 'hold'))
  events.push(held.event)

  return { held: held.booking, events }
}

describe('nilai yang boleh ditagih sepakat dengan payment-service', () => {
  test.each([
    ['harga tidak berubah', [1_000_000]],
    ['harga naik sekali lalu terverifikasi', [1_100_000, 1_100_000]],
    ['harga turun sekali lalu terverifikasi', [900_000, 900_000]],
    ['harga berubah dua kali sebelum stabil', [1_100_000, 1_250_000, 1_250_000]],
    ['harga naik lalu kembali ke semula', [1_100_000, 1_000_000, 1_000_000]],
  ] as const)('%s', (_name, prices) => {
    const { held, events } = flow(prices)

    expect(held.status).toBe('HELD')
    expect(payableAccordingToPaymentService(events)).toEqual(held.price.total)
  })

  test('sebelum persetujuan, nilai yang diyakini payment-service adalah harga baru', () => {
    // Bukan cacat, tetapi layak dinyatakan: `booking.price_changed` terbit
    // SEBELUM pengguna setuju, dan payment-service langsung memakainya. Aman
    // karena pembayaran tidak mungkin dibuat sebelum HELD — tabel transisi
    // yang menjaminnya, dan uji tabel yang membuktikannya.
    const { booking: start, event: created } = draftChange()
    const changed = run(start, {
      type: 'verifyPrice',
      at: minutesAfter(start.updatedAt, 1),
      verified: samplePrice(1_100_000),
    })

    expect(payableAccordingToPaymentService([created, changed.event])).toEqual(
      samplePrice(1_100_000).total,
    )
    expect(changed.booking.price.total).toEqual(samplePrice().total)
  })
})
