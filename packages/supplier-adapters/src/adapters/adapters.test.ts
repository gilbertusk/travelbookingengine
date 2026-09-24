import { describe, expect, test } from 'vitest'
import { searchResultSchema } from '../canonical/model.js'
import type { SupplierCode } from '../canonical/model.js'
import type { SupplierGateway } from '../ports/supplier-gateway.js'
import { fakeHttp, readFixture, respondWith } from '../testing/fakes.js'
import { createLunaAdapter } from './luna.js'
import { createNovaAdapter } from './nova.js'
import { createOrbitAdapter } from './orbit.js'
import { createSkyAdapter } from './sky.js'
import { createZephAdapter } from './zeph.js'

/**
 * Kelima adapter terhadap fixture sungguhan.
 *
 * Fixture ditangkap dari mock-supplier yang berjalan, bukan ditulis tangan.
 * Fixture buatan hanya membuktikan adapter cocok dengan apa yang penulisnya
 * bayangkan; yang perlu dibuktikan adalah adapter cocok dengan apa yang
 * supplier benar-benar kirimkan.
 */

const STAY = { checkIn: '2026-11-10', checkOut: '2026-11-12' }
const CRITERIA = { city: 'Bali', ...STAY, guests: 2 }

interface Subject {
  readonly code: SupplierCode
  readonly create: (response: ReturnType<typeof respondWith>) => SupplierGateway
  readonly fixture: (operation: string) => string
  readonly currency: 'IDR' | 'USD'
}

const SUBJECTS: readonly Subject[] = [
  {
    code: 'SKY',
    create: (response) => createSkyAdapter(fakeHttp(response)),
    fixture: (operation) => readFixture(`sky-${operation}.json`),
    currency: 'IDR',
  },
  {
    code: 'NOVA',
    create: (response) => createNovaAdapter(fakeHttp(response)),
    fixture: (operation) => readFixture(`nova-${operation}.json`),
    currency: 'USD',
  },
  {
    code: 'ORBIT',
    create: (response) => createOrbitAdapter(fakeHttp(response)),
    fixture: (operation) => readFixture(`orbit-${operation}.xml`),
    currency: 'IDR',
  },
  {
    code: 'LUNA',
    create: (response) => createLunaAdapter(fakeHttp(response)),
    fixture: (operation) => readFixture(`luna-${operation}.json`),
    currency: 'IDR',
  },
  {
    code: 'ZEPH',
    create: (response) => createZephAdapter(fakeHttp(response)),
    fixture: (operation) => readFixture(`zeph-${operation}.json`),
    currency: 'USD',
  },
]

function subject(code: SupplierCode): Subject {
  const found = SUBJECTS.find((candidate) => candidate.code === code)
  if (found === undefined) throw new Error(`tidak ada subjek untuk ${code}`)

  return found
}

describe.each(SUBJECTS)('adapter $code', (item) => {
  test('menormalisasi hasil pencarian ke bentuk kanonik', async () => {
    const adapter = item.create(respondWith(item.fixture('search')))

    const result = await adapter.search(CRITERIA)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    // Divalidasi terhadap skema kanonik, bukan hanya dibandingkan sebagian.
    // Bidang yang terlewat atau bertipe salah akan tertangkap di sini.
    expect(searchResultSchema.safeParse(result.value).success).toBe(true)
    expect(result.value.supplier).toBe(item.code)
    expect(result.value.properties.length).toBeGreaterThan(0)
  })

  test('setiap rate plan membawa harga total dan harga per malam', async () => {
    const adapter = item.create(respondWith(item.fixture('search')))

    const result = await adapter.search(CRITERIA)
    if (!result.ok) throw new Error('pencarian gagal')

    const ratePlans = result.value.properties.flatMap((property) =>
      property.roomTypes.flatMap((room) => room.ratePlans),
    )

    expect(ratePlans.length).toBeGreaterThan(0)
    for (const plan of ratePlans) {
      expect(plan.total.amountMinor).toBeGreaterThan(0)
      expect(plan.nightly.amountMinor).toBeGreaterThan(0)
      expect(Number.isInteger(plan.total.amountMinor)).toBe(true)
      expect(plan.supplierRatePlanId.length).toBeGreaterThan(0)
    }
  })

  test('mata uang ditandai sesuai supplier dan tidak dikonversi', async () => {
    // Konversi mata uang adalah tanggung jawab pricing-service. Adapter yang
    // diam-diam mengonversi membuat mustahil mengetahui harga asli supplier,
    // dan harga asli itulah yang dipakai saat rekonsiliasi.
    const adapter = item.create(respondWith(item.fixture('search')))

    const result = await adapter.search(CRITERIA)
    if (!result.ok) throw new Error('pencarian gagal')

    const currencies = new Set(
      result.value.properties
        .flatMap((property) => property.roomTypes.flatMap((room) => room.ratePlans))
        .flatMap((plan) => [plan.total.currency, plan.nightly.currency]),
    )

    expect([...currencies]).toEqual([item.currency])
  })

  test('respons berbentuk lain menghasilkan invalid_response, bukan lemparan', async () => {
    // Mode kegagalan `malformed`: status 200 dengan isi yang tidak dapat
    // diurai. Inilah kegagalan yang tidak terlihat sama sekali dari status.
    const adapter = item.create(respondWith('<<<bukan respons yang sah>>>'))

    const result = await adapter.search(CRITERIA)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('invalid_response')
    expect(result.error.supplier).toBe(item.code)
  })

  test('respons terpotong juga menghasilkan invalid_response', async () => {
    const truncated = item.fixture('search').slice(0, 120)
    const adapter = item.create(respondWith(truncated))

    const result = await adapter.search(CRITERIA)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('invalid_response')
  })

  test('menormalisasi hasil price check', async () => {
    const adapter = item.create(respondWith(item.fixture('price-check')))

    const result = await adapter.priceCheck('rate-apa-saja', STAY)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.total.currency).toBe(item.currency)
    // Bukan toBe(false): mock-supplier menggeser harga secara acak sekitar
    // sepersepuluh permintaan, dan pergeseran harga adalah jawaban yang sah.
    expect(typeof result.value.changed).toBe('boolean')
    expect(result.value.total.amountMinor).toBeGreaterThan(0)
  })

  test('menormalisasi hasil hold, dengan kedaluwarsa sebagai titik waktu', async () => {
    const adapter = item.create(respondWith(item.fixture('hold'), { status: 201 }))

    const result = await adapter.hold('rate-apa-saja', STAY, 2)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.supplierHoldId.length).toBeGreaterThan(0)
    // Kedaluwarsa hold adalah detik tertentu, bukan tanggal kalender.
    expect(Number.isNaN(Date.parse(result.value.expiresAt))).toBe(false)
    expect(result.value.total.currency).toBe(item.currency)
  })

  test('menormalisasi hasil pemesanan', async () => {
    const adapter = item.create(respondWith(item.fixture('booking'), { status: 201 }))

    const result = await adapter.book('hold-apa-saja', { fullName: 'Budi Santoso' }, 'kunci-1')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.supplier).toBe(item.code)
    expect(result.value.status).toBe('CONFIRMED')
    expect(result.value.bookingReference.length).toBeGreaterThan(0)
    expect(result.value.total.currency).toBe(item.currency)
  })

  test('tanggal menginap pada pemesanan kembali menjadi tanggal kalender', async () => {
    const adapter = item.create(respondWith(item.fixture('booking'), { status: 201 }))

    const result = await adapter.book('hold-apa-saja', { fullName: 'Budi' }, 'kunci-1')
    if (!result.ok) throw new Error('pemesanan gagal')

    // ORBIT mengirim DD/MM/YYYY, NOVA mengirim datetime, LUNA mengirim epoch.
    // Ketiganya harus keluar sebagai tanggal yang sama.
    expect(result.value.checkIn).toBe('2026-11-10')
    expect(result.value.checkOut).toBe('2026-11-12')
  })

  test('membatalkan pemesanan tanpa mengembalikan apa pun', async () => {
    const adapter = item.create(respondWith(item.fixture('cancel')))

    const result = await adapter.cancel('bkg-1')

    expect(result.ok).toBe(true)
  })

  test('mengambil pemesanan berdasarkan referensinya', async () => {
    const adapter = item.create(respondWith(item.fixture('retrieve')))

    const result = await adapter.getBooking('bkg-1')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.supplier).toBe(item.code)
    expect(result.value.bookingReference.length).toBeGreaterThan(0)
  })

  test('pembatalan tercermin pada status pemesanan', async () => {
    // Status yang tidak berubah setelah pembatalan berarti rekonsiliasi pada
    // Step 28 akan menganggap pemesanan itu masih hidup di sisi supplier.
    const adapter = item.create(respondWith(item.fixture('cancelled')))

    const result = await adapter.getBooking('bkg-1')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.status).toBe('CANCELLED')
  })

  test('mencari pemesanan berdasarkan idempotency key', async () => {
    // Inilah jalan keluar dari ketidakpastian setelah book kehabisan waktu:
    // sistem tidak tahu apakah pemesanan terbentuk, dan bertanya dengan
    // kuncinya adalah satu-satunya cara aman mencari tahu.
    const http = fakeHttp(respondWith(item.fixture('retrieve')))
    const gateway = buildWith(item.code, http)

    const result = await gateway.findBookingByIdempotencyKey('kunci-hilang-1')

    expect(result.ok).toBe(true)
    const sent = http.calls[0]?.request
    expect(`${sent?.path ?? ''}${sent?.body ?? ''}`).toContain('kunci-hilang-1')
  })

  test('pemesanan yang tidak ditemukan menjadi not_found', async () => {
    const adapter = item.create(respondWith(notFoundBody(item.code), { status: 404 }))

    const result = await adapter.getBooking('bkg-tidak-ada')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('not_found')
  })

  test('membawa idempotency key pada operasi book', async () => {
    const http = fakeHttp(respondWith(item.fixture('booking'), { status: 201 }))
    const adapter = SUBJECTS.find((candidate) => candidate.code === item.code)?.code
    expect(adapter).toBeDefined()

    const gateway = buildWith(item.code, http)
    await gateway.book('hold-apa-saja', { fullName: 'Budi' }, 'kunci-unik-123')

    const sent = http.calls[0]?.request
    expect(sent?.idempotencyKey).toBe('kunci-unik-123')
    // Juga harus ikut di badan permintaan: supplier tiruan membacanya dari sana.
    expect(`${sent?.body ?? ''}${JSON.stringify(sent?.headers ?? {})}`).toContain('kunci-unik-123')
  })
})

/** Bentuk badan galat 404 berbeda pada setiap supplier. */
function notFoundBody(code: SupplierCode): string {
  switch (code) {
    case 'SKY':
      return JSON.stringify({ error: 'NOT_FOUND' })
    case 'NOVA':
      return JSON.stringify({ error_code: 'NOT_FOUND', error_message: 'not_found' })
    case 'ORBIT':
      return '<?xml version="1.0"?><Envelope><Body><Fault><Code>NOT_FOUND</Code></Fault></Body></Envelope>'
    case 'LUNA':
      return JSON.stringify({ ok: false, err: 'NOT_FOUND' })
    case 'ZEPH':
      return JSON.stringify({ status: 'error', error: { code: 'NOT_FOUND', kind: 'not_found' } })
  }
}

function buildWith(code: SupplierCode, http: ReturnType<typeof fakeHttp>): SupplierGateway {
  switch (code) {
    case 'SKY':
      return createSkyAdapter(http)
    case 'NOVA':
      return createNovaAdapter(http)
    case 'ORBIT':
      return createOrbitAdapter(http)
    case 'LUNA':
      return createLunaAdapter(http)
    case 'ZEPH':
      return createZephAdapter(http)
  }
}

describe('keanehan khas tiap supplier', () => {
  test('ORBIT: elemen tunggal tetap menjadi larik', async () => {
    // Satu hotel dalam hasil datang sebagai objek, bukan larik. Kode yang
    // langsung memanggil .map() bekerja sempurna sampai ada pencarian yang
    // hanya menemukan satu properti.
    const single = `<?xml version="1.0"?><Envelope><Body><AvailabilityResponse><HotelList><Hotel><Code>orbit-1</Code><Name>Satu Hotel</Name><Stars>4</Stars><RoomList><Room><Code>rmt-1</Code><Name>Superior</Name><MaxPax>2</MaxPax><RateList><Rate><RateCode>r-1</RateCode><Description>Kamar saja</Description><Amount Currency="IDR">100000</Amount><NightlyAmount Currency="IDR">50000</NightlyAmount><Refundable>N</Refundable><Breakfast>N</Breakfast><Allotment>3</Allotment></Rate></RateList></Room></RoomList></Hotel></HotelList></AvailabilityResponse></Body></Envelope>`

    const adapter = createOrbitAdapter(fakeHttp(respondWith(single)))
    const result = await adapter.search(CRITERIA)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.properties).toHaveLength(1)
    expect(result.value.properties[0]?.roomTypes[0]?.ratePlans).toHaveLength(1)
  })

  test('ORBIT: fault dengan status 200 tetap menjadi kegagalan', async () => {
    const fault = `<?xml version="1.0"?><Envelope><Body><Fault><Code>SOLD_OUT</Code><Message>SOLD_OUT</Message></Fault></Body></Envelope>`

    const adapter = createOrbitAdapter(fakeHttp(respondWith(fault, { status: 200 })))
    const result = await adapter.search(CRITERIA)

    expect(result.ok).toBe(false)
    if (result.ok) return
    // Status 200 tidak masuk pemetaan konflik, jadi jatuh ke upstream_error —
    // yang penting bukan ditelan sebagai hasil kosong yang sah.
    expect(result.error.kind).toBe('upstream_error')
  })

  test('ORBIT: mengirim tanggal sebagai DD/MM/YYYY', async () => {
    const http = fakeHttp(respondWith(readFixture('orbit-search.xml')))
    await createOrbitAdapter(http).search({ ...CRITERIA, checkIn: '2026-11-25' })

    expect(http.calls[0]?.request.body).toContain('<FromDate>25/11/2026</FromDate>')
  })

  test('NOVA: mengirim tanggal sebagai datetime UTC', async () => {
    const http = fakeHttp(respondWith(readFixture('nova-search.json')))
    await createNovaAdapter(http).search(CRITERIA)

    expect(http.calls[0]?.request.body).toContain('"arrival_date":"2026-11-10T00:00:00Z"')
  })

  test('LUNA: mengirim tanggal sebagai epoch detik', async () => {
    const http = fakeHttp(respondWith(readFixture('luna-search.json')))
    await createLunaAdapter(http).search(CRITERIA)

    expect(http.calls[0]?.request.body).toContain('"in":1794268800')
  })

  test('LUNA: boolean 0 dan 1 menjadi boolean sungguhan', async () => {
    const adapter = createLunaAdapter(fakeHttp(respondWith(readFixture('luna-search.json'))))
    const result = await adapter.search(CRITERIA)
    if (!result.ok) throw new Error('pencarian gagal')

    const plans = result.value.properties.flatMap((property) =>
      property.roomTypes.flatMap((room) => room.ratePlans),
    )

    expect(plans.some((plan) => plan.breakfastIncluded)).toBe(true)
    expect(plans.some((plan) => !plan.breakfastIncluded)).toBe(true)
    for (const plan of plans) expect(typeof plan.breakfastIncluded).toBe('boolean')
  })

  test('ZEPH: angka berupa string diurai, bukan dipaksa', async () => {
    const adapter = createZephAdapter(fakeHttp(respondWith(readFixture('zeph-search.json'))))
    const result = await adapter.search(CRITERIA)
    if (!result.ok) throw new Error('pencarian gagal')

    const property = result.value.properties[0]
    expect(typeof property?.starRating).toBe('number')

    const plan = property?.roomTypes[0]?.ratePlans[0]
    expect(Number.isInteger(plan?.availability.unitsLeft)).toBe(true)
  })

  test('ZEPH: harga dengan pemisah ribuan tetap benar', async () => {
    const body = JSON.stringify({
      status: 'ok',
      payload: {
        offer_ref: 'z-1',
        price: '1,250.00',
        currency: 'USD',
        changed: false,
      },
    })

    const adapter = createZephAdapter(fakeHttp(respondWith(body)))
    const result = await adapter.priceCheck('z-1', STAY)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.total.amountMinor).toBe(125_000)
  })

  test('NOVA: pilihan datar dikelompokkan kembali menjadi jenis kamar', async () => {
    const adapter = createNovaAdapter(fakeHttp(respondWith(readFixture('nova-search.json'))))
    const result = await adapter.search(CRITERIA)
    if (!result.ok) throw new Error('pencarian gagal')

    const property = result.value.properties[0]
    expect(property?.roomTypes.length).toBeGreaterThan(0)

    // Nama jenis kamar tidak lagi memuat nama rate plan-nya.
    for (const room of property?.roomTypes ?? []) {
      expect(room.name).not.toContain(' — ')
      expect(room.ratePlans.length).toBeGreaterThan(0)
    }
  })

  test('SKY: menyertakan data pendukung untuk pemetaan katalog', async () => {
    // Alamat dan koordinat tidak dipakai adapter mana pun, tetapi Step 12b
    // membutuhkannya untuk membangun tabel pemetaan properti.
    const adapter = subject('SKY').create(respondWith(readFixture('sky-search.json')))
    const result = await adapter.search(CRITERIA)
    if (!result.ok) throw new Error('pencarian gagal')

    const property = result.value.properties[0]
    expect(property?.coordinates).toBeDefined()
    expect(property?.address).toBeDefined()
    expect(property?.amenities.length).toBeGreaterThan(0)
  })

  test('adapter mengembalikan pengenal supplier apa adanya', async () => {
    // Pemetaan ke pengenal internal bukan tanggung jawab lapisan ini.
    const adapter = subject('SKY').create(respondWith(readFixture('sky-search.json')))
    const result = await adapter.search(CRITERIA)
    if (!result.ok) throw new Error('pencarian gagal')

    expect(result.value.properties[0]?.supplierPropertyId).toMatch(/^sky-/)
  })
})
