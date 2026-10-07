import { describe, expect, test } from 'vitest'
import { MAX_TERM_NAME_LENGTH, offerTerms, type OfferTermsInput } from './offer-terms.js'

const valid: OfferTermsInput = {
  roomTypeName: '  Deluxe King  ',
  ratePlanName: 'Termasuk sarapan',
  breakfastIncluded: true,
  cancellationPolicy: { refundable: true, freeCancellationDays: 3 },
}

describe('ketentuan tawaran', () => {
  test('menerima ketentuan yang sah dan merapikan spasi nama', () => {
    const result = offerTerms(valid)

    expect(result).toEqual({
      ok: true,
      value: { ...valid, roomTypeName: 'Deluxe King' },
    })
  })

  test('kebijakan tidak dapat dikembalikan disalin tanpa tenggat', () => {
    const result = offerTerms({ ...valid, cancellationPolicy: { refundable: false } })

    expect(result.ok && result.value.cancellationPolicy).toEqual({ refundable: false })
  })

  test('kebijakan dapat dikembalikan tanpa tenggat tetap tanpa tenggat', () => {
    const result = offerTerms({ ...valid, cancellationPolicy: { refundable: true } })

    expect(result.ok && result.value.cancellationPolicy).toEqual({ refundable: true })
  })

  test.each([
    ['roomTypeName', { roomTypeName: '   ' }],
    ['ratePlanName', { ratePlanName: '' }],
  ] as const)('menolak %s yang kosong', (field, override) => {
    expect(offerTerms({ ...valid, ...override })).toEqual({
      ok: false,
      error: { kind: 'blank_name', field },
    })
  })

  test('menolak nama yang melebihi batas', () => {
    const result = offerTerms({ ...valid, roomTypeName: 'K'.repeat(MAX_TERM_NAME_LENGTH + 1) })

    expect(result).toEqual({
      ok: false,
      error: { kind: 'name_too_long', field: 'roomTypeName' },
    })
  })

  test.each([-1, 1.5, 366])('menolak tenggat pembatalan gratis %s hari', (days) => {
    const result = offerTerms({
      ...valid,
      cancellationPolicy: { refundable: true, freeCancellationDays: days },
    })

    expect(result).toEqual({ ok: false, error: { kind: 'invalid_free_cancellation_days' } })
  })
})
