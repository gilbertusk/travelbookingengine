import { XMLParser } from 'fast-xml-parser'
import request from 'supertest'
import { describe, expect, test } from 'vitest'
import { createHarness, STAY } from '../testing/harness.js'

/**
 * Membuktikan kelima supplier benar-benar berbicara dengan cara yang berbeda.
 *
 * Kalau test ini bisa lewat dengan satu bentuk respons yang sama untuk semua,
 * berarti lapisan adapter pada Step 10 tidak punya apa pun untuk diterjemahkan
 * dan seluruh premisnya hilang.
 */

const CITY = 'Bali'
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })

const epoch = (date: string): number => Math.floor(Date.parse(`${date}T00:00:00Z`) / 1_000)

const orbitEnvelope = (action: string, inner: string): string =>
  `<Envelope><Body><${action}>${inner}</${action}></Body></Envelope>`

describe('SKY — REST JSON, IDR, satuan terkecil', () => {
  test('mengembalikan hasil dengan field camelCase dan harga IDR', async () => {
    const { app } = createHarness()

    const response = await request(app)
      .post('/sky/availability')
      .send({ city: CITY, ...STAY, guests: 2 })

    expect(response.status).toBe(200)
    const hotel = response.body.results[0]
    expect(hotel).toHaveProperty('hotelId')
    expect(hotel).toHaveProperty('hotelName')
    expect(hotel.rooms[0].rates[0].price.currency).toBe('IDR')
    // Satuan terkecil IDR: bilangan bulat besar, bukan desimal
    expect(Number.isInteger(hotel.rooms[0].rates[0].price.amount)).toBe(true)
    expect(hotel.rooms[0].rates[0].price.amount).toBeGreaterThan(10_000)
  })

  test('menyelesaikan alur lengkap dari cari sampai pesan', async () => {
    const { app } = createHarness()

    const search = await request(app)
      .post('/sky/availability')
      .send({ city: CITY, ...STAY, guests: 2 })
    const rateId = search.body.results[0].rooms[0].rates[0].rateId

    const verify = await request(app)
      .post('/sky/rates/verify')
      .send({ rateId, ...STAY })
    expect(verify.status).toBe(200)

    const held = await request(app)
      .post('/sky/holds')
      .send({ rateId, ...STAY, guests: 2 })
    expect(held.status).toBe(201)
    expect(held.body.holdId).toMatch(/^hld_/)

    const booked = await request(app)
      .post('/sky/bookings')
      .send({ holdId: held.body.holdId, guestName: 'Budi', idempotencyKey: 'sky-e2e' })
    expect(booked.status).toBe(201)
    expect(booked.body.status).toBe('CONFIRMED')

    const recovered = await request(app).get('/sky/bookings').query({ idempotencyKey: 'sky-e2e' })
    expect(recovered.body.bookingId).toBe(booked.body.bookingId)
  })

  test('percobaan ulang dengan kunci sama menjawab 200, bukan membuat pemesanan baru', async () => {
    const { app } = createHarness()
    const search = await request(app)
      .post('/sky/availability')
      .send({ city: CITY, ...STAY, guests: 2 })
    const rateId = search.body.results[0].rooms[0].rates[0].rateId
    const held = await request(app)
      .post('/sky/holds')
      .send({ rateId, ...STAY, guests: 2 })
    const payload = { holdId: held.body.holdId, guestName: 'Budi', idempotencyKey: 'sky-ulang' }

    const pertama = await request(app).post('/sky/bookings').send(payload)
    const kedua = await request(app).post('/sky/bookings').send(payload)

    expect(pertama.status).toBe(201)
    expect(kedua.status).toBe(200)
    expect(kedua.body.bookingId).toBe(pertama.body.bookingId)
  })
})

describe('NOVA — REST JSON, USD, snake_case, ISO datetime', () => {
  test('memakai snake_case dan harga USD berdesimal', async () => {
    const { app } = createHarness()

    const response = await request(app)
      .post('/nova/search')
      .send({
        destination: CITY,
        arrival_date: `${STAY.checkIn}T00:00:00Z`,
        departure_date: `${STAY.checkOut}T00:00:00Z`,
        occupancy: { adults: 2 },
      })

    expect(response.status).toBe(200)
    const property = response.body.properties[0]
    expect(property).toHaveProperty('property_code')
    expect(property).not.toHaveProperty('hotelId')
    const option = property.room_options[0]
    expect(option.total_rate.currency_code).toBe('USD')
    // Satuan utama dengan dua desimal, bukan satuan terkecil
    expect(option.total_rate.value).toMatch(/^\d+\.\d{2}$/)
  })

  test('menolak datetime yang tidak sah', async () => {
    const { app } = createHarness()

    const response = await request(app)
      .post('/nova/search')
      .send({
        destination: CITY,
        arrival_date: '10/11/2026',
        departure_date: `${STAY.checkOut}T00:00:00Z`,
        occupancy: { adults: 2 },
      })

    expect(response.status).toBe(400)
    expect(response.body.error_code).toBe('INVALID_REQUEST')
  })
})

describe('ORBIT — SOAP XML, IDR, DD/MM/YYYY', () => {
  test('mengembalikan XML dengan penamaan PascalCase', async () => {
    const { app } = createHarness()

    const response = await request(app)
      .post('/orbit/soap')
      .set('SOAPAction', 'Availability')
      .set('Content-Type', 'text/xml')
      .send(
        orbitEnvelope(
          'AvailabilityRequest',
          `<Location>${CITY}</Location><FromDate>10/11/2026</FromDate>` +
            `<ToDate>12/11/2026</ToDate><PaxCount>2</PaxCount>`,
        ),
      )

    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toContain('text/xml')
    const parsed = parser.parse(response.text)
    const hotel = parsed.Envelope.Body.AvailabilityResponse.HotelList.Hotel[0]
    expect(hotel).toHaveProperty('Code')
    expect(hotel).toHaveProperty('RoomList')
    expect(hotel.RoomList.Room[0].RateList.Rate[0].Amount['@_Currency']).toBe('IDR')
    expect(hotel.RoomList.Room[0].RateList.Rate[0].Refundable).toMatch(/^[YN]$/)
  })

  test('menafsirkan DD/MM/YYYY sebagai hari-bulan, bukan bulan-hari', async () => {
    // 10/11/2026 adalah 10 November. Parser yang mengasumsikan urutan Amerika
    // akan membacanya sebagai 11 Oktober dan seluruh hasilnya salah tanggal.
    const { app } = createHarness()

    const response = await request(app)
      .post('/orbit/soap')
      .set('SOAPAction', 'Availability')
      .set('Content-Type', 'text/xml')
      .send(
        orbitEnvelope(
          'AvailabilityRequest',
          `<Location>${CITY}</Location><FromDate>25/12/2026</FromDate>` +
            `<ToDate>27/12/2026</ToDate><PaxCount>2</PaxCount>`,
        ),
      )

    // Tanggal 25 tidak mungkin menjadi bulan; bila terbaca sebagai bulan,
    // permintaan akan gagal dengan INVALID_DATE.
    expect(response.status).toBe(200)
  })

  test('menolak SOAPAction yang tidak dikenal', async () => {
    const { app } = createHarness()

    const response = await request(app)
      .post('/orbit/soap')
      .set('SOAPAction', 'Teleport')
      .set('Content-Type', 'text/xml')
      .send(orbitEnvelope('AvailabilityRequest', ''))

    expect(response.status).toBe(400)
    expect(response.text).toContain('UNKNOWN_ACTION')
  })

  test('menolak amplop yang tidak dapat diurai', async () => {
    const { app } = createHarness()

    const response = await request(app)
      .post('/orbit/soap')
      .set('SOAPAction', 'Availability')
      .set('Content-Type', 'text/xml')
      .send('<Envelope><Body><Unclosed>')

    expect(response.status).toBe(400)
  })
})

describe('LUNA — REST JSON, IDR, epoch detik, nama field pendek', () => {
  test('memakai epoch detik dan nama field terpangkas', async () => {
    const { app } = createHarness()

    const response = await request(app)
      .post('/luna/availability')
      .send({ q: { loc: CITY, in: epoch(STAY.checkIn), out: epoch(STAY.checkOut), pax: 2 } })

    expect(response.status).toBe(200)
    expect(response.body.ok).toBe(true)
    const item = response.body.data.items[0]
    expect(item).toHaveProperty('hid')
    expect(item).toHaveProperty('hname')
    expect(item.rt[0].rp[0]).toHaveProperty('pid')
    expect(item.rt[0].rp[0].cur).toBe('IDR')
    // Boolean dikirim sebagai 0/1, bukan true/false
    expect([0, 1]).toContain(item.rt[0].rp[0].ref)
  })

  test('membalas amplop ok:false ketika gagal', async () => {
    const { app } = createHarness()

    const response = await request(app).post('/luna/rate').send({ pid: 'tidak-ada', in: 1, out: 2 })

    expect(response.status).toBe(404)
    expect(response.body.ok).toBe(false)
  })
})

describe('ZEPH — REST JSON, USD, harga sebagai string', () => {
  test('membungkus hasil dalam amplop status dan payload', async () => {
    const { app } = createHarness()

    const response = await request(app)
      .post('/zeph/availability')
      .send({ location: CITY, dates: { from: STAY.checkIn, to: STAY.checkOut }, pax: 2 })

    expect(response.status).toBe(200)
    expect(response.body.status).toBe('ok')
    const hotel = response.body.payload.hotels[0]
    expect(typeof hotel.rooms[0].offers[0].price).toBe('string')
    expect(typeof hotel.rooms[0].offers[0].remaining).toBe('string')
    expect(hotel.rooms[0].offers[0].currency).toBe('USD')
  })
})

describe('properti yang sama lintas supplier', () => {
  test('memakai pengenal dan nama berbeda untuk properti yang sama', () => {
    // Inilah yang membuat deduplikasi pada Step 13 punya pekerjaan, dan yang
    // membuat pemetaan pada Step 12b tidak bisa sekadar mencocokkan nama.
    const harness = createHarness()
    const property = harness.context.catalog.allProperties()[0]
    if (property === undefined) throw new Error('katalog kosong')

    const refSky = harness.context.refs.propertyRef('SKY', property.id)
    const refNova = harness.context.refs.propertyRef('NOVA', property.id)

    expect(refSky).not.toBe(refNova)
    expect(harness.context.refs.propertyIdOf('SKY', refSky)).toBe(property.id)
    expect(harness.context.refs.propertyIdOf('NOVA', refNova)).toBe(property.id)
    // Pengenal supplier satu tidak berarti apa pun bagi supplier lain
    expect(harness.context.refs.propertyIdOf('NOVA', refSky)).toBeUndefined()
  })
})

/**
 * Alur lengkap untuk empat supplier lainnya.
 *
 * Menguji pencarian saja tidak cukup: bagian yang paling mungkin salah justru
 * hold, book, dan pemulihan status — dan tiap supplier menamai ketiganya
 * dengan cara yang sama sekali berbeda.
 */
describe('alur lengkap tiap supplier', () => {
  test('NOVA: cari, tahan, konfirmasi, pulihkan, batalkan', async () => {
    const { app } = createHarness()
    const body = {
      destination: CITY,
      arrival_date: `${STAY.checkIn}T00:00:00Z`,
      departure_date: `${STAY.checkOut}T00:00:00Z`,
      occupancy: { adults: 2 },
    }

    const search = await request(app).post('/nova/search').send(body)
    const optionCode = search.body.properties[0].room_options[0].option_code

    const check = await request(app)
      .post('/nova/rate-check')
      .send({ option_code: optionCode, ...body })
    expect(check.status).toBe(200)

    const held = await request(app)
      .post('/nova/reservations/hold')
      .send({ option_code: optionCode, ...body })
    expect(held.status).toBe(201)

    const confirmed = await request(app)
      .post('/nova/reservations/confirm')
      .send({
        hold_reference: held.body.hold_reference,
        lead_guest: { full_name: 'Budi' },
        idempotency_key: 'nova-e2e',
      })
    expect(confirmed.body.reservation_status).toBe('confirmed')

    const recovered = await request(app)
      .get('/nova/reservations/lookup')
      .query({ idempotency_key: 'nova-e2e' })
    expect(recovered.body.reservation_code).toBe(confirmed.body.reservation_code)

    const cancelled = await request(app)
      .post('/nova/reservations/cancel')
      .send({ reservation_code: confirmed.body.reservation_code })
    expect(cancelled.body.reservation_status).toBe('cancelled')
  })

  test('ORBIT: cari, tahan, pesan, ambil, batalkan lewat SOAP', async () => {
    const { app } = createHarness()
    const soap = (action: string, inner: string) =>
      request(app)
        .post('/orbit/soap')
        .set('SOAPAction', action)
        .set('Content-Type', 'text/xml')
        .send(orbitEnvelope(`${action}Request`, inner))

    const dates = '<FromDate>10/11/2026</FromDate><ToDate>12/11/2026</ToDate>'
    const search = await soap(
      'Availability',
      `<Location>${CITY}</Location>${dates}<PaxCount>2</PaxCount>`,
    )
    const rateCode = parser.parse(search.text).Envelope.Body.AvailabilityResponse.HotelList.Hotel[0]
      .RoomList.Room[0].RateList.Rate[0].RateCode

    const checked = await soap('RateCheck', `<RateCode>${String(rateCode)}</RateCode>${dates}`)
    expect(parser.parse(checked.text).Envelope.Body.RateCheckResponse.Changed).toMatch(/^[YN]$/)

    const held = await soap(
      'Hold',
      `<RateCode>${String(rateCode)}</RateCode>${dates}<PaxCount>2</PaxCount>`,
    )
    const holdCode = parser.parse(held.text).Envelope.Body.HoldResponse.HoldCode

    const booked = await soap(
      'Book',
      `<HoldCode>${String(holdCode)}</HoldCode><GuestName>Budi</GuestName><ClientReference>orbit-e2e</ClientReference>`,
    )
    const bookingCode = parser.parse(booked.text).Envelope.Body.BookResponse.BookingCode
    expect(bookingCode).toMatch(/^bkg_/)

    const retrieved = await soap('Retrieve', `<ClientReference>orbit-e2e</ClientReference>`)
    expect(parser.parse(retrieved.text).Envelope.Body.RetrieveResponse.BookingCode).toBe(
      bookingCode,
    )

    const cancelled = await soap('Cancel', `<BookingCode>${String(bookingCode)}</BookingCode>`)
    expect(parser.parse(cancelled.text).Envelope.Body.CancelResponse.Status).toBe('CANCELLED')
  })

  test('LUNA: cari, tahan, pesan, pulihkan, batalkan', async () => {
    const { app } = createHarness()
    const q = { loc: CITY, in: epoch(STAY.checkIn), out: epoch(STAY.checkOut), pax: 2 }

    const search = await request(app).post('/luna/availability').send({ q })
    const pid = search.body.data.items[0].rt[0].rp[0].pid

    const rate = await request(app).post('/luna/rate').send({ pid, in: q.in, out: q.out })
    expect(rate.body.ok).toBe(true)

    const held = await request(app).post('/luna/hold').send({ pid, in: q.in, out: q.out, pax: 2 })
    expect(held.status).toBe(201)

    const booked = await request(app)
      .post('/luna/book')
      .send({ h: held.body.data.h, gn: 'Budi', ik: 'luna-e2e' })
    expect(booked.body.data.st).toBe(1)

    const recovered = await request(app).get('/luna/bk').query({ ik: 'luna-e2e' })
    expect(recovered.body.data.b).toBe(booked.body.data.b)

    const voided = await request(app).post('/luna/void').send({ b: booked.body.data.b })
    expect(voided.body.data.st).toBe(0)
  })

  test('ZEPH: cari, harga, tahan, pesan, pulihkan, batalkan', async () => {
    const { app } = createHarness()
    const dates = { from: STAY.checkIn, to: STAY.checkOut }

    const search = await request(app)
      .post('/zeph/availability')
      .send({ location: CITY, dates, pax: 2 })
    const offerRef = search.body.payload.hotels[0].rooms[0].offers[0].ref

    const priced = await request(app)
      .post('/zeph/offers/price')
      .send({ offer_ref: offerRef, dates })
    expect(priced.body.status).toBe('ok')

    const held = await request(app)
      .post('/zeph/offers/hold')
      .send({ offer_ref: offerRef, dates, pax: 2 })
    expect(held.status).toBe(201)

    const booked = await request(app)
      .post('/zeph/bookings')
      .send({ hold_ref: held.body.payload.hold_ref, guest: 'Budi', request_id: 'zeph-e2e' })
    expect(booked.body.payload.state).toBe('confirmed')

    const recovered = await request(app).get('/zeph/bookings').query({ request_id: 'zeph-e2e' })
    expect(recovered.body.payload.ref).toBe(booked.body.payload.ref)

    const cancelled = await request(app)
      .post(`/zeph/bookings/${String(booked.body.payload.ref)}/cancel`)
      .send({})
    expect(cancelled.body.payload.state).toBe('cancelled')
  })
})

/**
 * Jalur penolakan tiap supplier.
 *
 * Supplier tiruan yang selalu menjawab 200 akan membuat adapter pada Step 10
 * terlihat benar padahal belum pernah menghadapi satu pun penolakan.
 */
describe('penolakan masukan tidak sah', () => {
  test('SKY menolak rate id yang tidak dikenal dan body tidak lengkap', async () => {
    const { app } = createHarness()

    expect((await request(app).post('/sky/availability').send({ city: 'B' })).status).toBe(400)
    expect(
      (
        await request(app)
          .post('/sky/rates/verify')
          .send({ rateId: 'palsu', ...STAY })
      ).status,
    ).toBe(400)
    expect(
      (
        await request(app)
          .post('/sky/holds')
          .send({ rateId: 'palsu', ...STAY, guests: 2 })
      ).status,
    ).toBe(400)
    expect((await request(app).post('/sky/bookings').send({ holdId: 'x' })).status).toBe(400)
    expect((await request(app).get('/sky/bookings')).status).toBe(400)
    expect((await request(app).get('/sky/bookings/tidak-ada')).status).toBe(404)
    expect((await request(app).delete('/sky/bookings/tidak-ada')).status).toBe(404)
  })

  test('NOVA menolak option code palsu dan pemesanan yang tidak ada', async () => {
    const { app } = createHarness()
    const dates = {
      arrival_date: `${STAY.checkIn}T00:00:00Z`,
      departure_date: `${STAY.checkOut}T00:00:00Z`,
    }

    expect(
      (
        await request(app)
          .post('/nova/rate-check')
          .send({ option_code: 'palsu', ...dates })
      ).status,
    ).toBe(400)
    expect(
      (
        await request(app)
          .post('/nova/reservations/hold')
          .send({ option_code: 'palsu', ...dates, occupancy: { adults: 2 } })
      ).status,
    ).toBe(400)
    expect((await request(app).post('/nova/reservations/confirm').send({})).status).toBe(400)
    expect((await request(app).post('/nova/reservations/cancel').send({})).status).toBe(400)
    expect((await request(app).get('/nova/reservations/tidak-ada')).status).toBe(404)
  })

  test('LUNA menolak skema salah dan pemesanan yang tidak ada', async () => {
    const { app } = createHarness()

    expect((await request(app).post('/luna/availability').send({})).status).toBe(400)
    expect(
      (await request(app).post('/luna/hold').send({ pid: 'palsu', in: 1, out: 2, pax: 2 })).status,
    ).toBe(404)
    expect((await request(app).post('/luna/book').send({})).status).toBe(400)
    expect((await request(app).post('/luna/void').send({})).status).toBe(400)
    expect((await request(app).get('/luna/bk').query({ b: 'tidak-ada' })).status).toBe(404)
  })

  test('ZEPH menolak offer palsu dan permintaan tanpa request id', async () => {
    const { app } = createHarness()
    const dates = { from: STAY.checkIn, to: STAY.checkOut }

    expect((await request(app).post('/zeph/availability').send({ location: 'B' })).status).toBe(400)
    expect(
      (await request(app).post('/zeph/offers/price').send({ offer_ref: 'palsu', dates })).status,
    ).toBe(404)
    expect(
      (await request(app).post('/zeph/offers/hold').send({ offer_ref: 'palsu', dates, pax: 2 }))
        .status,
    ).toBe(404)
    expect((await request(app).post('/zeph/bookings').send({})).status).toBe(400)
    expect((await request(app).get('/zeph/bookings')).status).toBe(400)
    expect((await request(app).get('/zeph/bookings/tidak-ada')).status).toBe(404)
    expect((await request(app).post('/zeph/bookings/tidak-ada/cancel').send({})).status).toBe(404)
  })

  test('ORBIT menolak rate code palsu dan pemesanan yang tidak ada', async () => {
    const { app } = createHarness()
    const soap = (action: string, inner: string) =>
      request(app)
        .post('/orbit/soap')
        .set('SOAPAction', action)
        .set('Content-Type', 'text/xml')
        .send(orbitEnvelope(`${action}Request`, inner))

    const dates = '<FromDate>10/11/2026</FromDate><ToDate>12/11/2026</ToDate>'
    expect((await soap('RateCheck', `<RateCode>palsu</RateCode>${dates}`)).status).toBe(404)
    expect((await soap('Hold', `<RateCode>palsu</RateCode>${dates}`)).status).toBe(404)
    expect((await soap('Book', '<HoldCode>palsu</HoldCode><GuestName>A</GuestName>')).status).toBe(
      404,
    )
    expect((await soap('Cancel', '<BookingCode>palsu</BookingCode>')).status).toBe(404)
    expect((await soap('Retrieve', '<BookingCode>palsu</BookingCode>')).status).toBe(404)
    // Tanggal dengan format Amerika ditolak, bukan diterima diam-diam
    expect(
      (await soap('Availability', `<Location>${CITY}</Location><FromDate>2026-11-10</FromDate>`))
        .status,
    ).toBe(400)
  })
})
