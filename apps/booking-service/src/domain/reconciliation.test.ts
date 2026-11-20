import { describe, expect, test } from 'vitest'
import { idr, sampleStay } from '../testing/builders.js'
import {
  compare,
  type LedgerAnswer,
  type LocalRecord,
  type SupplierRecord,
} from './reconciliation.js'

const confirmed: LocalRecord = {
  status: 'CONFIRMED',
  supplier: 'SKY',
  handle: 'SKY-BK-1',
  stay: sampleStay(),
  supplierTotal: idr(1_800_000),
}

const active: SupplierRecord = {
  status: 'CONFIRMED',
  total: idr(1_800_000),
  checkIn: '2026-11-10',
  checkOut: '2026-11-12',
}

const found = (record: Partial<SupplierRecord> = {}): LedgerAnswer => ({
  kind: 'found',
  record: { ...active, ...record },
})

describe('CONFIRMED di sistem', () => {
  test('catatan yang sama persis cocok', () => {
    expect(compare(confirmed, found())).toEqual({ kind: 'match' })
  })

  test('tidak ditemukan di supplier: ketidaksesuaian, dengan pegangan yang dipakai bertanya', () => {
    const verdict = compare(confirmed, { kind: 'not_found' })

    expect(verdict).toEqual({
      kind: 'mismatch',
      mismatch: 'missing_at_supplier',
      reason: 'rekonsiliasi: CONFIRMED di sini, tidak ditemukan di supplier SKY (SKY-BK-1)',
    })
  })

  test('dibatalkan di supplier', () => {
    expect(compare(confirmed, found({ status: 'CANCELLED' }))).toMatchObject({
      mismatch: 'cancelled_at_supplier',
    })
  })

  test('nilai berbeda dari harga bersih saat hold — satu rupiah pun', () => {
    const verdict = compare(confirmed, found({ total: idr(1_800_001) }))

    expect(verdict).toMatchObject({ mismatch: 'amount_mismatch' })
    expect(verdict.kind === 'mismatch' && verdict.reason).toContain('1800000')
  })

  test('mata uang berbeda adalah nilai berbeda', () => {
    const verdict = compare(confirmed, {
      kind: 'found',
      record: { ...active, total: { amountMinor: 1_800_000, currency: 'USD' } },
    })

    expect(verdict).toMatchObject({ mismatch: 'amount_mismatch' })
  })

  test.each([
    ['tanggal masuk', { checkIn: '2026-11-11' }],
    ['tanggal keluar', { checkOut: '2026-11-13' }],
  ])('%s berbeda', (_label, dates) => {
    expect(compare(confirmed, found(dates))).toMatchObject({ mismatch: 'dates_mismatch' })
  })

  test('tanggal yang tidak dijawab supplier ditulis "?" di alasan, bukan "undefined"', () => {
    const verdict = compare(confirmed, found({ checkIn: undefined, checkOut: '2026-11-13' }))

    expect(verdict.kind === 'mismatch' && verdict.reason).toContain('?–2026-11-13')
  })

  test('supplier yang tidak mengembalikan tanggal tidak dianggap berbeda tanggal', () => {
    expect(compare(confirmed, found({ checkIn: undefined, checkOut: undefined }))).toEqual({
      kind: 'match',
    })
  })

  test('nilai berbeda diperiksa sebelum tanggal: satu putusan, yang lebih mahal', () => {
    const verdict = compare(confirmed, found({ total: idr(1), checkIn: '2030-01-01' }))

    expect(verdict).toMatchObject({ mismatch: 'amount_mismatch' })
  })

  test('tanpa harga hold yang tercatat, nilai tidak dibandingkan — dan putusannya mengatakannya', () => {
    const verdict = compare({ ...confirmed, supplierTotal: undefined }, found({ total: idr(1) }))

    expect(verdict).toEqual({
      kind: 'match',
      note: 'nilai tidak dibandingkan: harga supplier saat hold tidak tercatat',
    })
  })
})

describe.each(['REFUNDED', 'CANCELLED'] as const)('%s di sistem', (status) => {
  const released: LocalRecord = { ...confirmed, status, supplierTotal: undefined }

  test('masih aktif di supplier: pemesanan bayangan', () => {
    expect(compare(released, found())).toEqual({
      kind: 'mismatch',
      mismatch: 'active_at_supplier',
      reason: `rekonsiliasi: ${status} di sini, masih AKTIF di supplier SKY (SKY-BK-1)`,
    })
  })

  test('tidak ditemukan atau dibatalkan di supplier: cocok', () => {
    expect(compare(released, { kind: 'not_found' })).toEqual({ kind: 'match' })
    expect(compare(released, found({ status: 'CANCELLED' }))).toEqual({ kind: 'match' })
  })

  test('nilai dan tanggal tidak berarti apa-apa untuk pemesanan yang memang tidak boleh ada', () => {
    expect(compare(released, found({ status: 'CANCELLED', total: idr(1) }))).toEqual({
      kind: 'match',
    })
  })
})

test('supplier yang tidak dapat ditanya: tidak diketahui, BUKAN ketidaksesuaian', () => {
  expect(compare(confirmed, { kind: 'unreachable' })).toEqual({ kind: 'unverified' })
  expect(compare({ ...confirmed, status: 'REFUNDED' }, { kind: 'unreachable' })).toEqual({
    kind: 'unverified',
  })
})
