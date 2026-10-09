import { describe, expect, test } from 'vitest'
import type { SupplierCode } from '../canonical/model.js'
import { createSupplierRegistry, mockSupplierRegistryConfig } from '../registry/registry.js'
import { fakeHttp, respondWith } from '../testing/fakes.js'
import { attribute, list, parseXml, soapBody, text, toArray } from '../http/xml.js'
import { createOrbitAdapter } from './orbit.js'
import { createSkyAdapter } from './sky.js'

/**
 * Tepian.
 *
 * Bagian yang tidak muncul pada fixture mana pun karena mock-supplier selalu
 * mengirim respons yang lengkap. Supplier sungguhan tidak selalu begitu, dan
 * yang paling berbahaya bukan respons yang jelas rusak — melainkan respons
 * yang hampir benar.
 */

const STAY = { checkIn: '2026-11-10', checkOut: '2026-11-12' }
const CRITERIA = { city: 'Bali', ...STAY, guests: 2 }

describe('bagian respons yang hilang', () => {
  test('SKY: pemesanan tanpa nama tamu tetap sah', async () => {
    const body = JSON.stringify({
      bookingId: 'bkg-1',
      status: 'CONFIRMED',
      price: { amount: 500_000, currency: 'IDR' },
      checkIn: '2026-11-10',
      checkOut: '2026-11-12',
    })

    const result = await createSkyAdapter(fakeHttp(respondWith(body))).getBooking('bkg-1')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.guestName).toBeUndefined()
  })

  test('ORBIT: pemesanan tanpa tanggal tetap sah', async () => {
    // Beberapa operasi ORBIT tidak mengembalikan tanggal menginap. Itu bukan
    // kegagalan — pemesanannya tetap ada dan referensinya tetap berlaku.
    const body = `<?xml version="1.0"?><Envelope><Body><RetrieveResponse><BookingCode>bkg-1</BookingCode><Status>CONFIRMED</Status><Amount Currency="IDR">500000</Amount></RetrieveResponse></Body></Envelope>`

    const result = await createOrbitAdapter(fakeHttp(respondWith(body))).getBooking('bkg-1')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.checkIn).toBeUndefined()
    expect(result.value.checkOut).toBeUndefined()
  })

  test('ORBIT: price check tanpa RateCode memakai kode yang dikirim', async () => {
    const body = `<?xml version="1.0"?><Envelope><Body><RateCheckResponse><Amount Currency="IDR">500000</Amount><Changed>Y</Changed><Refundable>Y</Refundable></RateCheckResponse></Body></Envelope>`

    const result = await createOrbitAdapter(fakeHttp(respondWith(body))).priceCheck('r-asli', STAY)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.supplierRatePlanId).toBe('r-asli')
    expect(result.value.changed).toBe(true)
  })

  test('ORBIT: hasil pencarian kosong bukan kegagalan', async () => {
    const body = `<?xml version="1.0"?><Envelope><Body><AvailabilityResponse><HotelList/></AvailabilityResponse></Body></Envelope>`

    const result = await createOrbitAdapter(fakeHttp(respondWith(body))).search(CRITERIA)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.properties).toEqual([])
  })

  test('ORBIT: hotel tanpa Code ditolak', async () => {
    const body = `<?xml version="1.0"?><Envelope><Body><AvailabilityResponse><HotelList><Hotel><Name>Tanpa kode</Name></Hotel></HotelList></AvailabilityResponse></Body></Envelope>`

    const result = await createOrbitAdapter(fakeHttp(respondWith(body))).search(CRITERIA)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('invalid_response')
  })

  test('ORBIT: status pemesanan yang tidak dikenali ditolak', async () => {
    const body = `<?xml version="1.0"?><Envelope><Body><RetrieveResponse><BookingCode>bkg-1</BookingCode><Status>ENTAH</Status><Amount Currency="IDR">500000</Amount></RetrieveResponse></Body></Envelope>`

    const result = await createOrbitAdapter(fakeHttp(respondWith(body))).getBooking('bkg-1')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('invalid_response')
  })

  test('ORBIT: amplop tanpa isi yang diharapkan ditolak', async () => {
    const body = `<?xml version="1.0"?><Envelope><Body><SesuatuYangLain/></Body></Envelope>`

    const result = await createOrbitAdapter(fakeHttp(respondWith(body))).hold('r-1', STAY, 2)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('invalid_response')
  })

  test('ORBIT: status galat tanpa amplop dipetakan dari statusnya', async () => {
    const result = await createOrbitAdapter(
      fakeHttp(respondWith('bukan xml sama sekali', { status: 503 })),
    ).search(CRITERIA)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('unavailable')
  })
})

describe('pembacaan XML', () => {
  test('elemen tunggal, banyak, dan tidak ada semuanya menjadi larik', () => {
    expect(toArray({ a: 1 })).toHaveLength(1)
    expect(toArray([{ a: 1 }, { b: 2 }])).toHaveLength(2)
    expect(toArray(undefined)).toEqual([])
    expect(toArray('teks')).toEqual([])
  })

  test('daftar yang pembungkusnya tidak ada menghasilkan larik kosong', () => {
    expect(list(undefined, 'RoomList', 'Room')).toEqual([])
    expect(list({}, 'RoomList', 'Room')).toEqual([])
  })

  test('teks dibaca dari elemen polos maupun elemen beratribut', () => {
    const document = parseXml('<Root><A>satu</A><B Currency="IDR">dua</B></Root>')
    const root = document?.Root as Record<string, unknown>

    expect(text(root, 'A')).toBe('satu')
    expect(text(root, 'B')).toBe('dua')
    expect(text(root, 'TidakAda')).toBeUndefined()
  })

  test('atribut hanya terbaca pada elemen yang punya atribut', () => {
    const document = parseXml('<Root><A>satu</A><B Currency="IDR">dua</B></Root>')
    const root = document?.Root as Record<string, unknown>

    expect(attribute(root, 'B', 'Currency')).toBe('IDR')
    expect(attribute(root, 'A', 'Currency')).toBeUndefined()
    expect(attribute(root, 'TidakAda', 'Currency')).toBeUndefined()
  })

  test('XML yang tidak dapat diurai menghasilkan undefined, bukan lemparan', () => {
    expect(parseXml('<Root><Belum')).toBeUndefined()
  })

  test('badan kosong terurai menjadi dokumen kosong, dan ditolak di lapisan amplop', () => {
    // fast-xml-parser mengembalikan objek kosong untuk masukan kosong, bukan
    // galat. Penolakannya terjadi saat amplop SOAP dicari dan tidak ditemukan.
    expect(parseXml('')).toEqual({})
    expect(soapBody({})).toBeUndefined()
  })

  test('angka tidak diubah otomatis sehingga nol di depan tidak hilang', () => {
    // Kode properti "0012" yang menjadi 12 adalah pengenal yang tidak cocok
    // lagi dengan milik supplier.
    const document = parseXml('<Root><Code>0012</Code></Root>')
    const root = document?.Root as Record<string, unknown>

    expect(text(root, 'Code')).toBe('0012')
  })
})

describe('registri', () => {
  test('kode supplier yang tidak dikenal melempar galat yang jelas', () => {
    const registry = createSupplierRegistry(mockSupplierRegistryConfig('http://localhost:4000'))

    expect(() => registry.get('MARS' as SupplierCode)).toThrow(/MARS/)
  })
})

describe('price check tanpa kebijakan pembatalan', () => {
  // Kebijakan dari price check menentukan berapa yang dikembalikan saat
  // pengguna membatalkan (Step 25). Jawaban tanpa kebijakan bukan "boleh
  // dibatalkan gratis" — itu jawaban yang tidak dapat dipakai.
  test('SKY tanpa bidang refundable menjadi invalid_response', async () => {
    const body = JSON.stringify({
      rateId: 'r-1',
      price: { amount: 500_000, currency: 'IDR' },
      changed: false,
    })

    const result = await createSkyAdapter(fakeHttp(respondWith(body))).priceCheck('r-1', STAY)

    expect(!result.ok && result.error.kind).toBe('invalid_response')
  })

  test('ORBIT dengan Refundable yang bukan Y atau N menjadi invalid_response', async () => {
    const body = `<?xml version="1.0"?><Envelope><Body><RateCheckResponse><RateCode>r-1</RateCode><Amount Currency="IDR">500000</Amount><Changed>N</Changed><Refundable>kadang</Refundable></RateCheckResponse></Body></Envelope>`

    const result = await createOrbitAdapter(fakeHttp(respondWith(body))).priceCheck('r-1', STAY)

    expect(!result.ok && result.error.kind).toBe('invalid_response')
  })
})
