import { describe, expect, test } from 'vitest'
import { OBJECT_KEY_PREFIX } from '../domain/object-key.js'
import {
  BOOKING_ID,
  CONFIRMED_AT,
  ISSUE_DELAY_MS,
  USER,
  confirmedSource,
  world,
} from '../testing/fakes.js'
import { issueVoucher } from './issue-voucher.js'

describe('penerbitan voucher', () => {
  test('pemesanan CONFIRMED menghasilkan satu voucher, satu berkas, satu peristiwa', async () => {
    const w = world()

    const result = await issueVoucher(w.deps, BOOKING_ID)

    expect(result.kind).toBe('issued')
    expect(w.vouchers.rows.size).toBe(1)
    expect(w.storage.objects.size).toBe(1)
    expect(w.events.published).toHaveLength(1)
    const voucher = w.vouchers.rows.get(BOOKING_ID)
    expect(voucher).toMatchObject({
      bookingId: BOOKING_ID,
      userId: USER,
      confirmedAt: CONFIRMED_AT,
      issuedAt: w.clock.value,
    })
    expect(voucher?.sizeBytes).toBe(w.storage.objects.get(voucher?.objectKey ?? '')?.byteLength)
  })

  test('isi voucher disusun dari pemesanan dan properti katalog', async () => {
    const w = world()

    await issueVoucher(w.deps, BOOKING_ID)

    expect(w.rendered[0]).toMatchObject({
      bookingReference: 'SKY-BK-7F3A21',
      property: { name: 'Padma Bali Boutique Hotel' },
      guest: { name: 'Sari Wulandari' },
    })
  })

  test('selisih konfirmasi sampai terbit dicatat sebagai metrik M7, dalam detik', async () => {
    const w = world()

    await issueVoucher(w.deps, BOOKING_ID)

    expect(w.latencies).toEqual([ISSUE_DELAY_MS / 1_000])
    expect(w.events.published[0]?.latencyMs).toBe(ISSUE_DELAY_MS)
  })

  test('kunci objek tidak memuat bookingId', async () => {
    const w = world()

    await issueVoucher(w.deps, BOOKING_ID)

    const key = w.vouchers.rows.get(BOOKING_ID)?.objectKey ?? ''
    expect(key.startsWith(OBJECT_KEY_PREFIX)).toBe(true)
    expect(key).not.toContain(BOOKING_ID)
    expect(key).not.toContain(BOOKING_ID.replace(/-/g, ''))
  })
})

describe('idempotensi (perintah yang sama dua kali)', () => {
  test('perintah yang sama dua kali menghasilkan satu voucher', async () => {
    const w = world()

    const first = await issueVoucher(w.deps, BOOKING_ID)
    const second = await issueVoucher(w.deps, BOOKING_ID)

    expect(first.kind).toBe('issued')
    expect(second).toEqual({
      kind: 'already_issued',
      voucher: first.kind === 'issued' ? first.voucher : undefined,
    })
    expect(w.vouchers.rows.size).toBe(1)
    expect(w.storage.objects.size).toBe(1)
    // PDF tidak disusun ulang untuk voucher yang sudah ada.
    expect(w.rendered).toHaveLength(1)
  })

  test('perintah ulang mengumumkan voucher yang sama lagi, tanpa mencatat latensi kedua kalinya', async () => {
    const w = world()

    await issueVoucher(w.deps, BOOKING_ID)
    await issueVoucher(w.deps, BOOKING_ID)

    expect(w.events.published).toHaveLength(2)
    expect(w.events.published[1]?.voucher).toEqual(w.events.published[0]?.voucher)
    expect(w.latencies).toHaveLength(1)
  })

  test('dua penerbitan yang berpacu: yang kalah menghapus berkasnya dan mengembalikan pemenang', async () => {
    const w = world()
    const winner = { ...(await issuedVoucher()), objectKey: 'v/pemenang.pdf' }
    w.vouchers.beforeInsert = () => {
      w.vouchers.rows.set(BOOKING_ID, winner)
    }

    const result = await issueVoucher(w.deps, BOOKING_ID)

    expect(result).toEqual({ kind: 'already_issued', voucher: winner })
    expect(w.storage.objects.size).toBe(0)
    expect(w.latencies).toHaveLength(0)
  })

  test('berkas yang kalah berpacu gagal dihapus tidak menggagalkan perintah', async () => {
    const w = world()
    const winner = await issuedVoucher()
    w.storage.failRemove = true
    w.vouchers.beforeInsert = () => {
      w.vouchers.rows.set(BOOKING_ID, winner)
    }

    const result = await issueVoucher(w.deps, BOOKING_ID)

    expect(result.kind).toBe('already_issued')
  })
})

describe('penolakan', () => {
  test('pemesanan yang tidak ada ditolak', async () => {
    const w = world({ sources: [] })

    expect(await issueVoucher(w.deps, BOOKING_ID)).toEqual({
      kind: 'refused',
      refusal: { kind: 'booking_not_found' },
    })
  })

  test('pemesanan yang belum CONFIRMED ditolak tanpa menyimpan apa pun', async () => {
    const w = world({ sources: [confirmedSource({ status: 'PAID', supplierRef: null })] })

    const result = await issueVoucher(w.deps, BOOKING_ID)

    expect(result).toEqual({ kind: 'refused', refusal: { kind: 'not_confirmed', status: 'PAID' } })
    expect(w.storage.objects.size).toBe(0)
    expect(w.vouchers.rows.size).toBe(0)
  })

  test('properti yang belum terpetakan di katalog ditolak', async () => {
    const w = world({ property: null })

    expect(await issueVoucher(w.deps, BOOKING_ID)).toEqual({
      kind: 'refused',
      refusal: { kind: 'property_unmapped' },
    })
  })

  test('booking-service yang tidak dapat dihubungi dilempar, bukan ditolak', async () => {
    const w = world()
    w.bookings.failNext = true

    await expect(issueVoucher(w.deps, BOOKING_ID)).rejects.toThrow('mati sesaat')
  })
})

describe('waktu konfirmasi yang hilang', () => {
  test('latensi dicatat nol, bukan negatif', async () => {
    const w = world({ sources: [confirmedSource({ confirmedAt: null })] })

    await issueVoucher(w.deps, BOOKING_ID)

    expect(w.latencies).toEqual([0])
  })
})

async function issuedVoucher() {
  const w = world()
  const result = await issueVoucher(w.deps, BOOKING_ID)
  if (result.kind !== 'issued') throw new Error('persiapan gagal')
  return result.voucher
}
