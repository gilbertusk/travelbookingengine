#!/usr/bin/env node
/**
 * Menangkap respons sungguhan dari mock-supplier sebagai fixture.
 *
 * Fixture yang ditulis tangan hanya membuktikan bahwa adapter cocok dengan
 * apa yang penulisnya bayangkan. Yang perlu dibuktikan adalah adapter cocok
 * dengan apa yang supplier benar-benar kirimkan — termasuk keanehan yang
 * tidak terpikirkan saat menulis adapter: elemen XML tunggal yang tidak
 * menjadi larik, angka yang datang sebagai string, boolean yang datang
 * sebagai 0 dan 1.
 *
 * Jalankan mock-supplier lebih dulu, lalu:
 *   node packages/supplier-adapters/src/testing/capture-fixtures.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const BASE = process.env.MOCK_SUPPLIER_URL ?? 'http://localhost:4000'
const OUT = resolve(import.meta.dirname, 'fixtures')

const CITY = 'Bali'
const CHECK_IN = '2026-11-10'
const CHECK_OUT = '2026-11-12'
const GUESTS = 2

const toEpoch = (date) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000)
const toOrbitDate = (date) => date.split('-').reverse().join('/')

async function json(path, body, method = 'POST') {
  const response = await fetch(`${BASE}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })

  const text = await response.text()
  if (!response.ok) throw new Error(`${path} → ${String(response.status)}: ${text.slice(0, 200)}`)

  return JSON.parse(text)
}

async function soap(action, xml) {
  const response = await fetch(`${BASE}/orbit/soap`, {
    method: 'POST',
    headers: { 'content-type': 'text/xml', SOAPAction: action },
    body: xml,
  })

  const text = await response.text()
  if (!response.ok) throw new Error(`orbit ${action} → ${String(response.status)}: ${text}`)

  return text
}

function save(name, content) {
  const path = resolve(OUT, name)
  writeFileSync(
    path,
    typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`,
  )
  process.stdout.write(`  ditulis ${name}\n`)
}

/** Memangkas hasil pencarian agar fixture tetap dapat dibaca manusia. */
function firstFew(list, count = 2) {
  return list.slice(0, count)
}

async function captureSky() {
  const search = await json('/sky/availability', {
    city: CITY,
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    guests: GUESTS,
  })
  save('sky-search.json', { results: firstFew(search.results) })

  const rateId = search.results[0].rooms[0].rates[0].rateId
  save(
    'sky-price-check.json',
    await json('/sky/rates/verify', { rateId, checkIn: CHECK_IN, checkOut: CHECK_OUT }),
  )

  const hold = await json('/sky/holds', {
    rateId,
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    guests: GUESTS,
  })
  save('sky-hold.json', hold)

  const key = `cap-sky-${String(Date.now())}`
  const booking = await json('/sky/bookings', {
    holdId: hold.holdId,
    guestName: 'Budi Santoso',
    idempotencyKey: key,
  })
  save('sky-booking.json', booking)
  save('sky-retrieve.json', await json(`/sky/bookings/${booking.bookingId}`, undefined, 'GET'))
  save('sky-cancel.json', await json(`/sky/bookings/${booking.bookingId}`, undefined, 'DELETE'))
  save('sky-cancelled.json', await json(`/sky/bookings/${booking.bookingId}`, undefined, 'GET'))
}

async function captureNova() {
  const search = await json('/nova/search', {
    destination: CITY,
    arrival_date: `${CHECK_IN}T00:00:00Z`,
    departure_date: `${CHECK_OUT}T00:00:00Z`,
    occupancy: { adults: GUESTS },
  })
  save('nova-search.json', { properties: firstFew(search.properties) })

  const optionCode = search.properties[0].room_options[0].option_code
  const dates = { arrival_date: `${CHECK_IN}T00:00:00Z`, departure_date: `${CHECK_OUT}T00:00:00Z` }

  save(
    'nova-price-check.json',
    await json('/nova/rate-check', { option_code: optionCode, ...dates }),
  )

  const hold = await json('/nova/reservations/hold', {
    option_code: optionCode,
    ...dates,
    occupancy: { adults: GUESTS },
  })
  save('nova-hold.json', hold)

  const booking = await json('/nova/reservations/confirm', {
    hold_reference: hold.hold_reference,
    lead_guest: { full_name: 'Budi Santoso' },
    idempotency_key: `cap-nova-${String(Date.now())}`,
  })
  save('nova-booking.json', booking)
  save(
    'nova-retrieve.json',
    await json(`/nova/reservations/${booking.reservation_code}`, undefined, 'GET'),
  )
  save(
    'nova-cancel.json',
    await json('/nova/reservations/cancel', { reservation_code: booking.reservation_code }),
  )
  save(
    'nova-cancelled.json',
    await json(`/nova/reservations/${booking.reservation_code}`, undefined, 'GET'),
  )
}

async function captureOrbit() {
  const search = await soap(
    'Availability',
    `<Envelope><Body><AvailabilityRequest><Location>${CITY}</Location><FromDate>${toOrbitDate(CHECK_IN)}</FromDate><ToDate>${toOrbitDate(CHECK_OUT)}</ToDate><PaxCount>${String(GUESTS)}</PaxCount></AvailabilityRequest></Body></Envelope>`,
  )
  save('orbit-search.xml', search)

  const rateCode = /<RateCode>([^<]+)<\/RateCode>/.exec(search)?.[1]
  if (rateCode === undefined) throw new Error('tidak menemukan RateCode pada respons ORBIT')

  const dates = `<FromDate>${toOrbitDate(CHECK_IN)}</FromDate><ToDate>${toOrbitDate(CHECK_OUT)}</ToDate>`

  save(
    'orbit-price-check.xml',
    await soap(
      'RateCheck',
      `<Envelope><Body><RateCheckRequest><RateCode>${rateCode}</RateCode>${dates}</RateCheckRequest></Body></Envelope>`,
    ),
  )

  const hold = await soap(
    'Hold',
    `<Envelope><Body><HoldRequest><RateCode>${rateCode}</RateCode>${dates}<PaxCount>${String(GUESTS)}</PaxCount></HoldRequest></Body></Envelope>`,
  )
  save('orbit-hold.xml', hold)

  const holdCode = /<HoldCode>([^<]+)<\/HoldCode>/.exec(hold)?.[1]
  const booking = await soap(
    'Book',
    `<Envelope><Body><BookRequest><HoldCode>${String(holdCode)}</HoldCode><GuestName>Budi Santoso</GuestName><ClientReference>cap-orbit-${String(Date.now())}</ClientReference></BookRequest></Body></Envelope>`,
  )
  save('orbit-booking.xml', booking)

  const bookingCode = /<BookingCode>([^<]+)<\/BookingCode>/.exec(booking)?.[1]
  save(
    'orbit-retrieve.xml',
    await soap(
      'Retrieve',
      `<Envelope><Body><RetrieveRequest><BookingCode>${String(bookingCode)}</BookingCode></RetrieveRequest></Body></Envelope>`,
    ),
  )
  save(
    'orbit-cancel.xml',
    await soap(
      'Cancel',
      `<Envelope><Body><CancelRequest><BookingCode>${String(bookingCode)}</BookingCode></CancelRequest></Body></Envelope>`,
    ),
  )
  save(
    'orbit-cancelled.xml',
    await soap(
      'Retrieve',
      `<Envelope><Body><RetrieveRequest><BookingCode>${String(bookingCode)}</BookingCode></RetrieveRequest></Body></Envelope>`,
    ),
  )
}

async function captureLuna() {
  const search = await json('/luna/availability', {
    q: { loc: CITY, in: toEpoch(CHECK_IN), out: toEpoch(CHECK_OUT), pax: GUESTS },
  })
  save('luna-search.json', { ok: search.ok, data: { items: firstFew(search.data.items) } })

  const pid = search.data.items[0].rt[0].rp[0].pid
  const dates = { in: toEpoch(CHECK_IN), out: toEpoch(CHECK_OUT) }

  save('luna-price-check.json', await json('/luna/rate', { pid, ...dates }))

  const hold = await json('/luna/hold', { pid, ...dates, pax: GUESTS })
  save('luna-hold.json', hold)

  const booking = await json('/luna/book', {
    h: hold.data.h,
    gn: 'Budi Santoso',
    ik: `cap-luna-${String(Date.now())}`,
  })
  save('luna-booking.json', booking)
  save('luna-retrieve.json', await json(`/luna/bk?b=${booking.data.b}`, undefined, 'GET'))
  save('luna-cancel.json', await json('/luna/void', { b: booking.data.b }))
  save('luna-cancelled.json', await json(`/luna/bk?b=${booking.data.b}`, undefined, 'GET'))
}

async function captureZeph() {
  // ZEPH gagal sekitar 15% permintaan tanpa suntikan apa pun. Fixture harus
  // berupa respons berhasil, jadi percobaan diulang sampai satu berhasil.
  const search = await retry(() =>
    json('/zeph/availability', {
      location: CITY,
      dates: { from: CHECK_IN, to: CHECK_OUT },
      pax: GUESTS,
    }),
  )
  save('zeph-search.json', {
    status: search.status,
    payload: { hotels: firstFew(search.payload.hotels) },
  })

  const offerRef = search.payload.hotels[0].rooms[0].offers[0].ref
  const dates = { from: CHECK_IN, to: CHECK_OUT }

  save(
    'zeph-price-check.json',
    await retry(() => json('/zeph/offers/price', { offer_ref: offerRef, dates })),
  )

  const hold = await retry(() =>
    json('/zeph/offers/hold', { offer_ref: offerRef, dates, pax: GUESTS }),
  )
  save('zeph-hold.json', hold)

  const booking = await retry(() =>
    json('/zeph/bookings', {
      hold_ref: hold.payload.hold_ref,
      guest: 'Budi Santoso',
      request_id: `cap-zeph-${String(Date.now())}`,
    }),
  )
  save('zeph-booking.json', booking)
  save(
    'zeph-retrieve.json',
    await retry(() => json(`/zeph/bookings/${booking.payload.ref}`, undefined, 'GET')),
  )
  save(
    'zeph-cancel.json',
    await retry(() => json(`/zeph/bookings/${booking.payload.ref}/cancel`, undefined, 'POST')),
  )
  save(
    'zeph-cancelled.json',
    await retry(() => json(`/zeph/bookings/${booking.payload.ref}`, undefined, 'GET')),
  )
}

async function retry(operation, attempts = 12) {
  let lastError
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

mkdirSync(OUT, { recursive: true })

const CAPTURES = [
  ['SKY', captureSky],
  ['NOVA', captureNova],
  ['ORBIT', captureOrbit],
  ['LUNA', captureLuna],
  ['ZEPH', captureZeph],
]

for (const [code, capture] of CAPTURES) {
  process.stdout.write(`${code}\n`)
  await capture()
}

process.stdout.write('\nSeluruh fixture ditangkap dari mock-supplier yang berjalan.\n')
