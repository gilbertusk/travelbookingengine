import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { BOOKING_STATUSES, CANCELLATION_REASONS } from '../domain/booking.js'
import { BOOKING_EVENT_TYPES } from '../domain/events.js'
import { SAGA_STEPS } from '../domain/saga-definition.js'

/**
 * Menjaga skema dan migrasi tetap sepakat dengan domain dan dengan NFR.
 *
 * Skema Prisma dan migrasinya tidak dapat dijalankan tanpa Postgres, dan
 * Docker mati. Yang dapat dilakukan tanpa Postgres adalah membaca keduanya
 * sebagai teks dan memeriksa keputusan yang paling mahal bila salah. Uji ini
 * tidak membuktikan Postgres menerimanya — itu tetap tertulis di README
 * sebagai perintah yang belum dijalankan.
 */

const SCHEMA = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8')

const MIGRATIONS_DIR = new URL('../../prisma/migrations/', import.meta.url)
const MIGRATION = readdirSync(MIGRATIONS_DIR)
  .filter((name) => /^\d{14}_/.test(name))
  .sort()
  .map((name) => readFileSync(new URL(`${name}/migration.sql`, MIGRATIONS_DIR), 'utf8'))
  .join('\n')

function enumValues(name: string): readonly string[] {
  const block = new RegExp(`enum ${name} \\{([^}]*)\\}`).exec(SCHEMA)
  if (block === null) throw new Error(`enum ${name} tidak ada di schema.prisma`)

  return (block[1] ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('@@') && !line.startsWith('//'))
}

/** Satu deklarasi kolom Prisma, dengan tipe dan atributnya. */
function column(model: string, field: string): string {
  const body = new RegExp(`model ${model} \\{([^}]*)\\}`).exec(SCHEMA)?.[1] ?? ''
  const line = body.split('\n').find((candidate) => candidate.trim().startsWith(`${field} `))
  if (line === undefined) throw new Error(`${model}.${field} tidak ada di schema.prisma`)

  return line.trim().replace(/\s+/g, ' ')
}

/** Tipe SQL sebuah kolom di migrasi. */
function sqlType(table: string, name: string): string {
  const body = new RegExp(`CREATE TABLE "${table}" \\(([^;]*)\\);`).exec(MIGRATION)?.[1] ?? ''
  const line = body.split('\n').find((candidate) => candidate.trim().startsWith(`"${name}" `))
  if (line === undefined) throw new Error(`${table}.${name} tidak ada di migrasi`)

  return line.trim()
}

describe('tanggal menginap bertipe DATE (NFR-09, CONVENTIONS.md bagian 9)', () => {
  test.each(['checkIn', 'checkOut'])('skema: %s adalah @db.Date', (field) => {
    expect(column('Booking', field)).toMatch(/^\w+ DateTime @map\("\w+"\) @db\.Date$/)
  })

  test.each(['check_in', 'check_out'])('migrasi: %s adalah DATE, bukan TIMESTAMP', (name) => {
    expect(sqlType('bookings', name)).toBe(`"${name}" DATE NOT NULL,`)
  })
})

describe('waktu kejadian sistem bertipe TIMESTAMPTZ', () => {
  test.each([
    ['bookings', 'held_until'],
    ['bookings', 'created_at'],
    ['bookings', 'updated_at'],
    ['booking_events', 'occurred_at'],
    ['saga_states', 'deadline_at'],
    ['saga_states', 'leased_until'],
    ['saga_states', 'updated_at'],
    ['outbox', 'occurred_at'],
    ['outbox', 'published_at'],
    ['consumed_messages', 'consumed_at'],
  ])('%s.%s', (table, name) => {
    expect(sqlType(table, name)).toMatch(new RegExp(`^"${name}" TIMESTAMPTZ\\(3\\)`))
  })

  test('tidak ada satu pun kolom TIMESTAMP tanpa zona', () => {
    expect(MIGRATION).not.toMatch(/\bTIMESTAMP(\(\d\))?\s(?!WITH)/)
  })
})

describe('enum skema sepakat dengan tipe domain', () => {
  // Diperiksa dari DUA arah: nilai yang hanya ada di satu sisi lolos
  // kompilasi, lolos uji terhadap palsuan, lalu gagal sebagai galat Postgres
  // pada pemesanan pertama yang memakainya.
  test.each([
    ['BookingStatus', BOOKING_STATUSES],
    ['CancellationReason', CANCELLATION_REASONS],
    ['BookingEventType', BOOKING_EVENT_TYPES],
    ['PriceCheckOutcome', ['verified', 'changed', 'accepted']],
    ['SagaStep', SAGA_STEPS],
  ] as const)('%s', (name, expected) => {
    expect([...enumValues(name)].sort()).toEqual([...expected].sort())
  })
})

describe('keunikan dan indeks', () => {
  test('kunci idempotensi unik per pengguna', () => {
    expect(MIGRATION).toContain(
      'CREATE UNIQUE INDEX "bookings_user_id_idempotency_key_key" ON "bookings"("user_id", "idempotency_key");',
    )
  })

  test('nomor urut peristiwa unik per pemesanan', () => {
    expect(MIGRATION).toContain(
      'CREATE UNIQUE INDEX "booking_events_booking_id_sequence_key" ON "booking_events"("booking_id", "sequence");',
    )
  })

  test('penyapu hold punya indeks status dan batas waktu', () => {
    expect(MIGRATION).toContain(
      'CREATE INDEX "bookings_status_held_until_idx" ON "bookings"("status", "held_until");',
    )
  })

  test('peristiwa tidak dapat kehilangan pemesanannya', () => {
    expect(MIGRATION).toMatch(
      /FOREIGN KEY \("booking_id"\) REFERENCES "bookings"\("id"\) ON DELETE RESTRICT/,
    )
  })
})

describe('saga dan outbox (Step 19)', () => {
  test('satu saga per pemesanan', () => {
    expect(MIGRATION).toContain(
      'CREATE UNIQUE INDEX "saga_states_booking_id_key" ON "saga_states"("booking_id");',
    )
  })

  test('urutan outbox unik dan dilayani indeks pesan yang belum terbit', () => {
    expect(MIGRATION).toContain(
      'CREATE UNIQUE INDEX "outbox_sequence_key" ON "outbox"("sequence");',
    )
    expect(MIGRATION).toContain(
      'CREATE INDEX "outbox_published_at_sequence_idx" ON "outbox"("published_at", "sequence");',
    )
  })

  test('pesan yang sama tidak dapat dicatat terkonsumsi dua kali', () => {
    expect(sqlType('consumed_messages', 'event_id')).toBe('"event_id" UUID NOT NULL,')
    expect(MIGRATION).toContain('PRIMARY KEY ("event_id")')
  })

  test('penyapu saga punya indeks batas waktu dan sewa', () => {
    expect(MIGRATION).toContain('ON "saga_states"("deadline_at");')
    expect(MIGRATION).toContain('ON "saga_states"("leased_until");')
  })

  test('saga yang menunggu supplier tanpa batas waktu ditolak basis data', () => {
    expect(MIGRATION).toMatch(/"saga_states_confirm_has_deadline_check"/)
    expect(MIGRATION).toMatch(/"saga_states_started_has_lease_check"/)
  })
})

describe('booking_events hanya bertambah (NFR-10)', () => {
  test('trigger menolak UPDATE dan DELETE per baris', () => {
    expect(MIGRATION).toMatch(
      /CREATE TRIGGER "booking_events_no_update_or_delete"\s+BEFORE UPDATE OR DELETE ON "booking_events"\s+FOR EACH ROW/,
    )
  })

  test('trigger menolak TRUNCATE', () => {
    expect(MIGRATION).toMatch(/BEFORE TRUNCATE ON "booking_events"/)
  })

  test('fungsi trigger benar-benar menolak, bukan sekadar mencatat', () => {
    expect(MIGRATION).toMatch(/RAISE EXCEPTION 'booking_events hanya bertambah/)
  })
})

describe('uang pada skema (NFR-08)', () => {
  test('tidak ada kolom pecahan biner', () => {
    expect(SCHEMA).not.toMatch(/^\s*\w+\s+(Float|Decimal)\b/m)
  })

  test('setiap kolom nilai uang berpasangan dengan kolom mata uangnya', () => {
    expect(column('Booking', 'amountMinor')).toMatch(/^amountMinor Int /)
    expect(column('Booking', 'currency')).toMatch(/^currency String$/)
    expect(column('Booking', 'quotedAmountMinor')).toMatch(/^quotedAmountMinor Int\? /)
    expect(column('Booking', 'quotedCurrency')).toMatch(/^quotedCurrency String\? /)
  })
})
