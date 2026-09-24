import { describe, expect, test } from 'vitest'
import { searchResultSchema } from '../canonical/model.js'
import { fakeHttp, respondWith } from '../testing/fakes.js'
import { createLunaAdapter } from './luna.js'
import { createNovaAdapter } from './nova.js'
import { createOrbitAdapter } from './orbit.js'
import { createSkyAdapter } from './sky.js'
import { createZephAdapter } from './zeph.js'

/**
 * Respons yang menghilangkan keterangan opsional.
 *
 * Fixture yang ditangkap selalu lengkap — mock-supplier mengirim bintang,
 * koordinat, dan kapasitas kamar untuk setiap properti. Supplier sungguhan
 * tidak: sebagian properti tidak punya koordinat, sebagian rate plan tidak
 * menyebut tenggat pembatalan.
 *
 * Yang diuji di sini adalah bahwa keterangan yang hilang tetap hilang, bukan
 * menjadi `undefined` yang menyusup ke model kanonik atau nilai yang dikarang.
 */

const CRITERIA = { city: 'Bali', checkIn: '2026-11-10', checkOut: '2026-11-12', guests: 2 }

describe('properti tanpa keterangan opsional', () => {
  test('SKY tanpa bintang, alamat, koordinat, dan fasilitas', async () => {
    const body = JSON.stringify({
      results: [
        {
          hotelId: 'sky-1',
          hotelName: 'Penginapan Sederhana',
          rooms: [
            {
              roomId: 'rmt-1',
              roomName: 'Standar',
              rates: [
                {
                  rateId: 'r-1',
                  rateName: 'Kamar saja',
                  price: { amount: 500_000, currency: 'IDR' },
                  nightlyPrice: { amount: 250_000, currency: 'IDR' },
                  refundable: false,
                  breakfast: false,
                  unitsLeft: 2,
                },
              ],
            },
          ],
        },
      ],
    })

    const result = await createSkyAdapter(fakeHttp(respondWith(body))).search(CRITERIA)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const property = result.value.properties[0]
    expect(searchResultSchema.safeParse(result.value).success).toBe(true)
    expect(property?.starRating).toBeUndefined()
    expect(property?.coordinates).toBeUndefined()
    expect(property?.address).toBeUndefined()
    expect(property?.amenities).toEqual([])
    expect(property?.roomTypes[0]?.maxGuests).toBeUndefined()
    expect(property?.roomTypes[0]?.ratePlans[0]?.cancellationPolicy).toEqual({ refundable: false })
  })

  test('SKY yang dapat dibatalkan tanpa menyebut tenggatnya', async () => {
    // Tenggat yang tidak disebutkan tidak boleh dikarang — pengguna akan
    // membaca angka itu sebagai janji.
    const body = JSON.stringify({
      results: [
        {
          hotelId: 'sky-1',
          hotelName: 'Penginapan',
          rooms: [
            {
              roomId: 'rmt-1',
              roomName: 'Standar',
              rates: [
                {
                  rateId: 'r-1',
                  rateName: 'Bebas batal',
                  price: { amount: 500_000, currency: 'IDR' },
                  nightlyPrice: { amount: 250_000, currency: 'IDR' },
                  refundable: true,
                  breakfast: true,
                  unitsLeft: 1,
                },
              ],
            },
          ],
        },
      ],
    })

    const result = await createSkyAdapter(fakeHttp(respondWith(body))).search(CRITERIA)
    if (!result.ok) throw new Error('pencarian gagal')

    expect(result.value.properties[0]?.roomTypes[0]?.ratePlans[0]?.cancellationPolicy).toEqual({
      refundable: true,
    })
  })

  test('NOVA tanpa bintang dan koordinat', async () => {
    const body = JSON.stringify({
      properties: [
        {
          property_code: 'nova-1',
          property_name: 'PENGINAPAN',
          room_options: [
            {
              option_code: 'o-1',
              option_name: 'Standar',
              nightly_rate: { value: '25.00', currency_code: 'USD' },
              total_rate: { value: '50.00', currency_code: 'USD' },
              is_refundable: false,
              includes_breakfast: false,
              units_remaining: 3,
            },
          ],
        },
      ],
    })

    const result = await createNovaAdapter(fakeHttp(respondWith(body))).search(CRITERIA)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const property = result.value.properties[0]
    expect(property?.starRating).toBeUndefined()
    expect(property?.coordinates).toBeUndefined()
    // Tanpa pemisah, nama pilihan menjadi nama kamar sekaligus nama rate plan.
    expect(property?.roomTypes[0]?.name).toBe('Standar')
    expect(property?.roomTypes[0]?.ratePlans[0]?.name).toBe('Standar')
  })

  test('ORBIT tanpa bintang dan kapasitas kamar', async () => {
    const body = `<?xml version="1.0"?><Envelope><Body><AvailabilityResponse><HotelList><Hotel><Code>orbit-1</Code><Name>Penginapan</Name><RoomList><Room><Code>rmt-1</Code><Name>Standar</Name><RateList><Rate><RateCode>r-1</RateCode><Description>Kamar saja</Description><Amount Currency="IDR">500000</Amount><NightlyAmount Currency="IDR">250000</NightlyAmount><Refundable>N</Refundable><Breakfast>N</Breakfast><Allotment>2</Allotment></Rate></RateList></Room></RoomList></Hotel></HotelList></AvailabilityResponse></Body></Envelope>`

    const result = await createOrbitAdapter(fakeHttp(respondWith(body))).search(CRITERIA)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const property = result.value.properties[0]
    expect(property?.starRating).toBeUndefined()
    expect(property?.roomTypes[0]?.maxGuests).toBeUndefined()
  })

  test('LUNA tanpa bintang dan kapasitas kamar', async () => {
    const body = JSON.stringify({
      ok: true,
      data: {
        items: [
          {
            hid: 'luna-1',
            hname: 'Hotel Sederhana',
            rt: [
              {
                rid: 'rmt-1',
                rname: 'Standar',
                rp: [
                  {
                    pid: 'p-1',
                    pname: 'Kamar saja',
                    amt: 500_000,
                    namt: 250_000,
                    cur: 'IDR',
                    ref: 0,
                    bf: 0,
                    left: 2,
                  },
                ],
              },
            ],
          },
        ],
      },
    })

    const result = await createLunaAdapter(fakeHttp(respondWith(body))).search(CRITERIA)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.properties[0]?.starRating).toBeUndefined()
    expect(result.value.properties[0]?.roomTypes[0]?.maxGuests).toBeUndefined()
  })

  test('ZEPH tanpa peringatan bintang', async () => {
    const body = JSON.stringify({
      status: 'ok',
      payload: {
        hotels: [
          {
            ref: 'zeph-1',
            name: 'Penginapan',
            rooms: [
              {
                ref: 'rmt-1',
                name: 'Standar',
                offers: [
                  {
                    ref: 'o-1',
                    price: '50.00',
                    nightly: '25.00',
                    currency: 'USD',
                    cancellable: false,
                    breakfast: false,
                    remaining: '2',
                  },
                ],
              },
            ],
          },
        ],
      },
    })

    const result = await createZephAdapter(fakeHttp(respondWith(body))).search(CRITERIA)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.properties[0]?.starRating).toBeUndefined()
  })
})

describe('harga yang tidak dapat diwakili', () => {
  const stay = { checkIn: '2026-11-10', checkOut: '2026-11-12' }

  test('NOVA: harga bukan desimal menjadi invalid_response', async () => {
    const body = JSON.stringify({
      option_code: 'o-1',
      total_rate: { value: 'gratis', currency_code: 'USD' },
      rate_changed: false,
    })

    const result = await createNovaAdapter(fakeHttp(respondWith(body))).priceCheck('o-1', stay)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('invalid_response')
  })

  test('NOVA: harga terlalu rinci pada hasil pencarian menjadi invalid_response', async () => {
    // Tiga desimal untuk USD tidak dapat diwakili dalam sen. Membulatkannya
    // diam-diam berarti menampilkan harga yang tidak pernah disebut supplier.
    const body = JSON.stringify({
      properties: [
        {
          property_code: 'nova-1',
          property_name: 'PENGINAPAN',
          room_options: [
            {
              option_code: 'o-1',
              option_name: 'Standar',
              nightly_rate: { value: '25.005', currency_code: 'USD' },
              total_rate: { value: '50.00', currency_code: 'USD' },
              is_refundable: false,
              includes_breakfast: false,
              units_remaining: 3,
            },
          ],
        },
      ],
    })

    const result = await createNovaAdapter(fakeHttp(respondWith(body))).search(CRITERIA)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('invalid_response')
  })

  test('NOVA: harga pemesanan yang cacat menjadi invalid_response', async () => {
    const body = JSON.stringify({
      reservation_code: 'bkg-1',
      reservation_status: 'confirmed',
      total_rate: { value: 'entah', currency_code: 'USD' },
      arrival_date: '2026-11-10T00:00:00Z',
      departure_date: '2026-11-12T00:00:00Z',
    })

    const result = await createNovaAdapter(fakeHttp(respondWith(body))).getBooking('bkg-1')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('invalid_response')
  })

  test('NOVA: tanggal pemesanan yang cacat menjadi invalid_response', async () => {
    const body = JSON.stringify({
      reservation_code: 'bkg-1',
      reservation_status: 'confirmed',
      total_rate: { value: '50.00', currency_code: 'USD' },
      arrival_date: 'kemarin',
      departure_date: 'besok',
    })

    const result = await createNovaAdapter(fakeHttp(respondWith(body))).getBooking('bkg-1')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('invalid_response')
  })

  test('ZEPH: harga hold yang cacat menjadi invalid_response', async () => {
    const body = JSON.stringify({
      status: 'ok',
      payload: {
        hold_ref: 'h-1',
        expires_at: '2026-11-10T00:00:00Z',
        price: 'entah',
        currency: 'USD',
      },
    })

    const result = await createZephAdapter(fakeHttp(respondWith(body))).hold('o-1', stay, 2)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('invalid_response')
  })

  test('ZEPH: harga per malam yang cacat pada pencarian menjadi invalid_response', async () => {
    const body = JSON.stringify({
      status: 'ok',
      payload: {
        hotels: [
          {
            ref: 'zeph-1',
            name: 'Penginapan',
            rooms: [
              {
                ref: 'rmt-1',
                name: 'Standar',
                offers: [
                  {
                    ref: 'o-1',
                    price: '50.00',
                    nightly: 'entah',
                    currency: 'USD',
                    cancellable: false,
                    breakfast: false,
                    remaining: '2',
                  },
                ],
              },
            ],
          },
        ],
      },
    })

    const result = await createZephAdapter(fakeHttp(respondWith(body))).search(CRITERIA)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('invalid_response')
  })

  test('ORBIT: mata uang selain IDR ditolak, bukan dikonversi diam-diam', async () => {
    const body = `<?xml version="1.0"?><Envelope><Body><RateCheckResponse><RateCode>r-1</RateCode><Amount Currency="USD">50</Amount><Changed>N</Changed></RateCheckResponse></Body></Envelope>`

    const result = await createOrbitAdapter(fakeHttp(respondWith(body))).priceCheck('r-1', stay)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('invalid_response')
  })

  test('ORBIT: Changed yang bukan Y atau N ditolak', async () => {
    const body = `<?xml version="1.0"?><Envelope><Body><RateCheckResponse><RateCode>r-1</RateCode><Amount Currency="IDR">50000</Amount><Changed>mungkin</Changed></RateCheckResponse></Body></Envelope>`

    const result = await createOrbitAdapter(fakeHttp(respondWith(body))).priceCheck('r-1', stay)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('invalid_response')
  })
})

describe('tanggal permintaan yang tidak sah', () => {
  test('ORBIT menolak menyusun permintaan dengan tanggal yang salah bentuk', async () => {
    const http = fakeHttp(respondWith('<Envelope><Body/></Envelope>'))

    const result = await createOrbitAdapter(http).search({ ...CRITERIA, checkIn: '10/11/2026' })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('invalid_response')
    // Tidak ada permintaan yang dikirim: tanggal salah ditangkap sebelum
    // menyentuh jaringan.
    expect(http.calls).toHaveLength(0)
  })

  test('LUNA menolak menyusun permintaan dengan tanggal yang salah bentuk', async () => {
    const http = fakeHttp(respondWith('{}'))

    const result = await createLunaAdapter(http).hold(
      'p-1',
      { checkIn: 'kemarin', checkOut: 'besok' },
      2,
    )

    expect(result.ok).toBe(false)
    expect(http.calls).toHaveLength(0)
  })
})
