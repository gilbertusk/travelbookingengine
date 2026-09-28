import { runWithCorrelation } from '@tbe/shared-kernel'
import { describe, expect, test } from 'vitest'
import { COMMAND_PAYLOADS, COMMAND_SCHEMAS, COMMAND_TYPES } from './commands.js'
import { createMessage, envelopeSchema } from './envelope.js'
import { EVENT_PAYLOADS, EVENT_SCHEMAS, EVENT_TYPES, isEventType } from './events.js'
import { DEAD_LETTER_TOPIC, TOPICS, topicFor, unmappedEvents } from './topics.js'

const BOOKING_ID = '01927f3a-0000-7000-8000-000000000001'

describe('amplop', () => {
  test('mengisi seluruh field wajib tanpa diminta', () => {
    const message = createMessage({ eventType: 'booking.held', payload: { bookingId: BOOKING_ID } })

    expect(envelopeSchema.safeParse(message).success).toBe(true)
    expect(message.eventVersion).toBe(1)
  })

  test('mengambil correlationId dari konteks yang sedang berjalan', () => {
    // Penerusan manual adalah hal pertama yang terlupa ketika sebuah alur
    // bertambah satu lapis.
    runWithCorrelation('req-dari-http', () => {
      const message = createMessage({ eventType: 'booking.held', payload: {} })

      expect(message.correlationId).toBe('req-dari-http')
    })
  })

  test('membuat correlationId baru bila dipanggil di luar konteks', () => {
    const message = createMessage({ eventType: 'booking.held', payload: {} })

    expect(message.correlationId).toMatch(/^[0-9a-f]{8}-/)
  })

  test('eventId unik untuk setiap pesan', () => {
    const a = createMessage({ eventType: 'booking.held', payload: {} })
    const b = createMessage({ eventType: 'booking.held', payload: {} })

    expect(a.eventId).not.toBe(b.eventId)
  })

  test('menyertakan causationId hanya bila diberikan', () => {
    const tanpa = createMessage({ eventType: 'booking.held', payload: {} })
    const dengan = createMessage({
      eventType: 'booking.held',
      payload: {},
      causationId: BOOKING_ID,
    })

    expect(tanpa).not.toHaveProperty('causationId')
    expect(dengan.causationId).toBe(BOOKING_ID)
  })

  test('memakai eventId yang sudah ditetapkan, supaya penerbitan ulang dapat dikenali', () => {
    // Outbox Step 19 menerbitkan ulang baris yang sama setelah penerbit mati di
    // tengah jalan. Consumer menyaring duplikat lewat eventId; nilai baru pada
    // setiap percobaan membuat duplikatnya tidak dapat dikenali.
    const ditetapkan = '0199f000-0000-7000-8000-00000000abcd'
    const pertama = createMessage({ eventType: 'booking.held', payload: {}, eventId: ditetapkan })
    const ulang = createMessage({ eventType: 'booking.held', payload: {}, eventId: ditetapkan })

    expect(pertama.eventId).toBe(ditetapkan)
    expect(ulang.eventId).toBe(pertama.eventId)
  })

  test('menyertakan traceparent hanya bila diberikan', () => {
    const dengan = createMessage({
      eventType: 'booking.held',
      payload: {},
      traceparent: '00-abc-def-01',
    })

    expect(dengan.traceparent).toBe('00-abc-def-01')
  })
})

describe('registry', () => {
  test('setiap jenis peristiwa punya skema payload dan skema pesan', () => {
    for (const type of EVENT_TYPES) {
      expect(EVENT_PAYLOADS[type]).toBeDefined()
      expect(EVENT_SCHEMAS[type]).toBeDefined()
    }
  })

  test('setiap jenis perintah punya skema payload dan skema pesan', () => {
    for (const type of COMMAND_TYPES) {
      expect(COMMAND_PAYLOADS[type]).toBeDefined()
      expect(COMMAND_SCHEMAS[type]).toBeDefined()
    }
  })

  test('tidak ada nama yang dipakai sebagai peristiwa sekaligus perintah', () => {
    // Satu nama yang berperan ganda adalah cara tercepat mengaburkan batas
    // antara "sudah terjadi" dan "tolong kerjakan".
    const bertabrakan = EVENT_TYPES.filter((type) =>
      (COMMAND_TYPES as readonly string[]).includes(type),
    )

    expect(bertabrakan).toEqual([])
  })

  test('isEventType menolak nama yang bukan peristiwa', () => {
    expect(isEventType('booking.created')).toBe(true)
    expect(isEventType('supplier.confirm')).toBe(false)
    expect(isEventType('sesuatu.yang.lain')).toBe(false)
  })
})

describe('validasi payload', () => {
  test('menerima peristiwa yang benar', () => {
    const message = createMessage({
      eventType: 'booking.confirmed',
      payload: { bookingId: BOOKING_ID, supplier: 'SKY', supplierRef: 'sky-123' },
    })

    expect(EVENT_SCHEMAS['booking.confirmed'].safeParse(message).success).toBe(true)
  })

  test('menolak supplierRef kosong pada booking.confirmed', () => {
    // Booking reference kosong berarti tidak ada bukti pemesanan sama sekali.
    const message = createMessage({
      eventType: 'booking.confirmed',
      payload: { bookingId: BOOKING_ID, supplier: 'SKY', supplierRef: '' },
    })

    expect(EVENT_SCHEMAS['booking.confirmed'].safeParse(message).success).toBe(false)
  })

  test('menolak supplier yang tidak dikenal', () => {
    const message = createMessage({
      eventType: 'supplier.recovered',
      payload: { supplier: 'GARUDA' },
    })

    expect(EVENT_SCHEMAS['supplier.recovered'].safeParse(message).success).toBe(false)
  })

  test('menolak tanggal menginap berformat datetime', () => {
    // CONVENTIONS.md bagian 9: tanggal menginap adalah tanggal lokal properti,
    // bukan titik waktu. Membiarkan datetime lolos di sini berarti setiap
    // consumer harus menebak zona waktunya sendiri.
    const message = createMessage({
      eventType: 'booking.held',
      payload: { bookingId: BOOKING_ID, holdRef: 'h1', expiresAt: '2026-11-10T00:00:00Z' },
    })
    const salah = createMessage({
      eventType: 'booking.created',
      payload: {
        bookingId: BOOKING_ID,
        userId: BOOKING_ID,
        supplier: 'SKY',
        propertyId: 'p1',
        ratePlanRef: 'r1',
        checkIn: '2026-11-10T00:00:00Z',
        checkOut: '2026-11-12',
        guests: 2,
        amount: { amountMinor: 1_000_000, currency: 'IDR' },
      },
    })

    expect(EVENT_SCHEMAS['booking.held'].safeParse(message).success).toBe(true)
    expect(EVENT_SCHEMAS['booking.created'].safeParse(salah).success).toBe(false)
  })

  test('menolak nilai uang berdesimal', () => {
    // Desimal yang melewati JSON adalah cara paling mudah kehilangan satu sen.
    const message = createMessage({
      eventType: 'payment.succeeded',
      payload: {
        paymentId: BOOKING_ID,
        bookingId: BOOKING_ID,
        amount: { amountMinor: 1_000_000.5, currency: 'IDR' },
        gatewayRef: 'g1',
      },
    })

    expect(EVENT_SCHEMAS['payment.succeeded'].safeParse(message).success).toBe(false)
  })

  test('menolak mata uang di luar yang disepakati', () => {
    // Keputusan Q2: dua mata uang saja.
    const message = createMessage({
      eventType: 'payment.succeeded',
      payload: {
        paymentId: BOOKING_ID,
        bookingId: BOOKING_ID,
        amount: { amountMinor: 100, currency: 'SGD' },
        gatewayRef: 'g1',
      },
    })

    expect(EVENT_SCHEMAS['payment.succeeded'].safeParse(message).success).toBe(false)
  })

  test('search.performed tidak memuat field data pribadi', () => {
    const fields = Object.keys(EVENT_PAYLOADS['search.performed'].shape)

    expect(fields).not.toContain('userId')
    expect(fields).not.toContain('email')
  })

  test('menolak perintah tanpa idempotency key', () => {
    const message = createMessage({
      eventType: 'supplier.confirm',
      payload: {
        bookingId: BOOKING_ID,
        supplier: 'SKY',
        holdRef: 'h1',
        guestName: 'Budi',
        idempotencyKey: '',
      },
    })

    expect(COMMAND_SCHEMAS['supplier.confirm'].safeParse(message).success).toBe(false)
  })

  test('menolak pesan dengan eventType yang tidak cocok skemanya', () => {
    const message = createMessage({ eventType: 'booking.held', payload: {} })

    expect(EVENT_SCHEMAS['booking.confirmed'].safeParse(message).success).toBe(false)
  })
})

describe('topik', () => {
  test('setiap peristiwa terpetakan ke sebuah topik', () => {
    expect(unmappedEvents()).toEqual([])
  })

  test('peristiwa pemesanan dan pembayaran dikunci bookingId', () => {
    // Tanpa ini booking.confirmed dapat tiba sebelum booking.created, dan saga
    // membaca keadaan yang belum ada.
    expect(topicFor('booking.confirmed').partitionKey).toBe('bookingId')
    expect(topicFor('payment.succeeded').partitionKey).toBe('bookingId')
  })

  test('jawaban supplier atas konfirmasi dikunci bookingId dan beretensi panjang', () => {
    // Saga Step 19 membaca ketiganya. Kunci supplier akan memusatkan seluruh
    // saga satu supplier di satu partisi, dan retensi pendek membuang catatan
    // atas pemesanan yang sudah dibayar.
    for (const type of [
      'supplier.booking_confirmed',
      'supplier.booking_rejected',
      'supplier.booking_uncertain',
    ] as const) {
      expect(topicFor(type).partitionKey).toBe('bookingId')
      expect(topicFor(type).retentionMs).toBeGreaterThan(30 * 86_400_000)
    }
  })

  test('uncertain menuntut kunci idempotensi, supaya statusnya masih dapat ditanyakan', () => {
    const payload = {
      bookingId: BOOKING_ID,
      supplier: 'SKY',
      idempotencyKey: '',
      reason: 'timeout',
    }

    expect(EVENT_PAYLOADS['supplier.booking_uncertain'].safeParse(payload).success).toBe(false)
  })

  test('topik yang perlu dibangun ulang punya retensi panjang', () => {
    // Step 27 harus dapat membangun ulang agregat dari awal topik.
    const tigaPuluhHari = 30 * 86_400_000

    expect(topicFor('booking.created').retentionMs).toBeGreaterThan(tigaPuluhHari)
    expect(topicFor('payment.refunded').retentionMs).toBeGreaterThan(tigaPuluhHari)
  })

  test('topik analitik beretensi pendek', () => {
    expect(topicFor('search.performed').retentionMs).toBeLessThan(30 * 86_400_000)
  })

  test('nama topik unik dan berversi', () => {
    const nama = TOPICS.map((topic) => topic.name)

    expect(new Set(nama).size).toBe(nama.length)
    expect(nama.every((name) => /\.v\d+$/.test(name))).toBe(true)
    expect(DEAD_LETTER_TOPIC).toMatch(/\.v\d+$/)
  })

  test('setiap topik punya alasan tertulis untuk jumlah partisinya', () => {
    // Jumlah partisi yang dipilih tanpa alasan adalah jumlah partisi yang
    // tidak akan pernah ditinjau ulang.
    for (const topic of TOPICS) {
      expect(topic.rationale.length).toBeGreaterThan(40)
      expect(topic.partitions).toBeGreaterThan(0)
    }
  })

  test('topicFor melempar untuk peristiwa yang tidak dikenal', () => {
    // @ts-expect-error menguji jalur yang tidak dapat dicapai lewat tipe
    expect(() => topicFor('tidak.ada')).toThrow()
  })
})
