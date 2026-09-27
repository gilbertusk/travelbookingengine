import { ok } from '@tbe/shared-kernel'
import { describe, expect, test } from 'vitest'
import { draft, inState, narrow, samplePrice } from '../testing/builders.js'
import { baseOf, type Booking, type BookingIn } from './booking.js'
import { confirm, type Handler } from './handlers.js'
import type { PriceBreakdown } from './price.js'
import type { LocalDate } from './stay-dates.js'
import type { TransitionTable } from './transitions.js'

/**
 * Bukti tingkat TIPE: data yang tidak relevan tidak dapat melekat pada keadaan
 * yang salah.
 *
 * Setiap `@ts-expect-error` di bawah adalah klaim bahwa baris berikutnya TIDAK
 * dapat dikompilasi. Bila penjagaan tipenya dilepas — larangan `?: never` di
 * booking.ts, merek pada PriceBreakdown, tipe tabel transisi — baris itu
 * menjadi sah, direktifnya menjadi "tidak terpakai", dan `pnpm typecheck`
 * GAGAL. Uji ini tidak dibuktikan vitest; vitest hanya menjalankan badan uji
 * yang tidak berbahaya. Yang membuktikannya adalah tsc.
 *
 * Penyuntikan S6 di step doc melepas larangan `?: never` dan menjalankan tsc
 * terhadap berkas ini untuk memastikan kegagalan itu memang terjadi.
 */

describe('data melekat hanya pada keadaannya sendiri', () => {
  test('DRAFT tidak dapat membawa booking reference supplier', () => {
    const base = draft()

    // @ts-expect-error — supplierRef milik CONFIRMED, bukan DRAFT
    const withRef: Booking = { ...base, supplierRef: 'SKY-BK-1' }

    expect(withRef).toBeDefined()
  })

  /**
   * Kasus yang lolos union biasa: objek yang sudah bertipe, disebar ke keadaan
   * lain. Pemeriksaan bidang berlebih TypeScript hanya berlaku pada literal
   * segar; spread dari CONFIRMED lolos tanpa larangan `?: never`.
   */
  test('CONFIRMED yang disebar menjadi DRAFT ditolak karena membawa supplierRef', () => {
    const confirmed = narrow(inState('CONFIRMED'), 'CONFIRMED')

    // @ts-expect-error — supplierRef dan paymentId tidak boleh ada pada DRAFT
    const demoted: BookingIn<'DRAFT'> = { ...confirmed, status: 'DRAFT' }

    expect(demoted).toBeDefined()
  })

  test('CONFIRMED tanpa booking reference ditolak', () => {
    const paid = narrow(inState('PAID'), 'PAID')

    // @ts-expect-error — CONFIRMED WAJIB membawa supplierRef (FR-24)
    const confirmed: Booking = { ...paid, status: 'CONFIRMED' }

    expect(confirmed).toBeDefined()
  })

  test('HELD tanpa batas waktu hold ditolak', () => {
    const base = baseOf(inState('PRICE_CHECKED'))

    // @ts-expect-error — HELD wajib membawa heldUntil; penyapu Step 17 bergantung padanya
    const held: Booking = { ...base, status: 'HELD', holdRef: 'h-1' }

    expect(held).toBeDefined()
  })

  test('PAID tidak dapat tetap membawa token hold', () => {
    const heldBooking = narrow(inState('HELD'), 'HELD')

    // @ts-expect-error — holdRef dan heldUntil tidak boleh terbawa ke PAID
    const paid: Booking = { ...heldBooking, status: 'PAID', paymentId: 'p-1' }

    expect(paid).toBeDefined()
  })

  test('booking reference tidak dapat dipakai tanpa mempersempit keadaan', () => {
    const booking: Booking = inState('CONFIRMED')

    // Membaca bidangnya pada union diizinkan — hasilnya `string | undefined`,
    // karena larangan `?: never` pada keadaan lain tetap sebuah bidang
    // opsional. Yang dijaga adalah PEMAKAIANNYA: ia tidak dapat masuk ke tempat
    // yang menuntut string tanpa mempersempit status lebih dulu.
    // @ts-expect-error — string | undefined bukan string
    const ref: string = booking.supplierRef

    expect(ref).toBe('SKY-BK-778812')
  })
})

describe('nilai bermerek hanya lahir dari konstruktornya', () => {
  test('rincian harga tidak dapat disusun dari literal', () => {
    const real = samplePrice()

    // @ts-expect-error — total yang tidak dihitung dari barisnya
    const forged: PriceBreakdown = { total: real.total, lineItems: [] }

    expect(forged).toBeDefined()
  })

  test('string sembarang bukan tanggal menginap', () => {
    // @ts-expect-error — titik waktu ISO bukan tanggal kalender lokal
    const checkIn: LocalDate = '2026-11-10T00:00:00Z'

    expect(checkIn).toBeDefined()
  })
})

describe('tabel transisi diperiksa compiler per sel', () => {
  test('handler yang membaca paymentId tidak dapat dipasang pada HELD', () => {
    const table: Pick<TransitionTable, 'HELD'> = {
      // @ts-expect-error — `confirm` membutuhkan paymentId, dan HELD tidak punya
      HELD: { confirm },
    }

    expect(table).toBeDefined()
  })

  test('handler tidak dapat berakhir di keadaan selain tujuan perintahnya', () => {
    const cancelled = narrow(inState('CANCELLED'), 'CANCELLED')
    const change = {
      booking: cancelled,
      event: {
        type: 'BookingCancelled' as const,
        bookingId: cancelled.id,
        version: cancelled.version,
        occurredAt: cancelled.updatedAt,
        reason: 'user_request' as const,
      },
    }

    const wrong: Handler<BookingIn<'PAID'>, 'confirm'> = () =>
      // @ts-expect-error — COMMAND_TARGETS menyatakan `confirm` berakhir di CONFIRMED
      ok(change)

    expect(wrong).toBeDefined()
  })
})
