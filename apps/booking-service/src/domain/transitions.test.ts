import { describe, expect, test } from 'vitest'
import { draft, inState, sampleFor, validCommand } from '../testing/builders.js'
import { BOOKING_STATUSES, FINAL_STATUSES, isFinal, type BookingStatus } from './booking.js'
import { COMMAND_TARGETS, COMMAND_TYPES, type CommandType } from './commands.js'
import { InvalidTransitionError } from './errors.js'
import { TRANSITIONS, allowedCommands, applyCommand } from './transitions.js'

/**
 * Sifat tabel transisi.
 *
 * Seluruh uji di berkas ini bekerja atas SELURUH ruang keadaan — sepuluh
 * keadaan kali sepuluh perintah — bukan atas contoh pilihan. Sel yang tidak
 * pernah dipikirkan penulisnya adalah persis sel yang tidak akan muncul di uji
 * berbasis contoh.
 */

/** Graf keadaan, diturunkan dari DUA tabel data: TRANSITIONS dan COMMAND_TARGETS. */
function successors(status: BookingStatus): ReadonlySet<BookingStatus> {
  return new Set(allowedCommands(status).map((command) => COMMAND_TARGETS[command]))
}

function reachableFrom(start: BookingStatus): ReadonlySet<BookingStatus> {
  const seen = new Set<BookingStatus>([start])
  const queue: BookingStatus[] = [start]

  for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
    for (const next of successors(current)) {
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }

  return seen
}

const CELLS = BOOKING_STATUSES.flatMap((status) =>
  COMMAND_TYPES.map((command) => ({ status, command })),
)
const LEGAL = CELLS.filter(({ status, command }) => allowedCommands(status).includes(command))
const ILLEGAL = CELLS.filter(({ status, command }) => !allowedCommands(status).includes(command))

describe('tabel transisi sebagai spesifikasi', () => {
  /**
   * Tabel yang diharapkan ditulis ulang di sini, dengan tangan, sebagai
   * pasangan asal → tujuan. Pengulangan ini disengaja: ia yang menangkap
   * perubahan tabel yang tidak disengaja — sel yang ditambahkan ke keadaan
   * final, atau sel yang terhapus dari keadaan tengah — sebelum uji sifat di
   * bawah sempat menjelaskan kenapa perubahan itu salah.
   */
  test('tepat empat belas transisi yang disepakati', () => {
    const edges = LEGAL.map(
      ({ status, command }) => `${status} -${command}-> ${COMMAND_TARGETS[command]}`,
    )

    expect([...edges].sort()).toEqual(
      [
        'DRAFT -verifyPrice-> PRICE_CHECKED',
        'DRAFT -cancel-> CANCELLED',
        'PRICE_CHECKED -verifyPrice-> PRICE_CHECKED',
        'PRICE_CHECKED -acceptPrice-> PRICE_CHECKED',
        'PRICE_CHECKED -hold-> HELD',
        'PRICE_CHECKED -cancel-> CANCELLED',
        'HELD -expireHold-> EXPIRED',
        'HELD -recordPayment-> PAID',
        'HELD -cancel-> CANCELLED',
        'PAID -confirm-> CONFIRMED',
        'PAID -fail-> FAILED',
        'PAID -requireReview-> NEEDS_REVIEW',
        'FAILED -recordRefund-> REFUNDED',
        'FAILED -requireReview-> NEEDS_REVIEW',
      ].sort(),
    )
    // Dua sel PRICE_CHECKED → PRICE_CHECKED dihitung terpisah per perintah,
    // karena keduanya punya aturan berbeda: verifyPrice dan acceptPrice.
    expect(LEGAL).toHaveLength(14)
  })
})

describe('transisi sah', () => {
  test.each(LEGAL)(
    '$status + $command berhasil dan berakhir di keadaan tujuannya',
    ({ status, command }) => {
      const booking = sampleFor(status, command)
      const cmd = validCommand(booking, command)

      const result = applyCommand(booking, cmd)

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.booking.status).toBe(COMMAND_TARGETS[command])
      expect(result.value.booking.version).toBe(booking.version + 1)
      expect(result.value.booking.updatedAt).toEqual(cmd.at)
      // Peristiwa dan keadaan selalu sepakat: nomor urut peristiwa adalah versi
      // pemesanan sesudahnya, dan waktunya adalah waktu perintah.
      expect(result.value.event.bookingId).toBe(booking.id)
      expect(result.value.event.version).toBe(result.value.booking.version)
      expect(result.value.event.occurredAt).toEqual(cmd.at)
    },
  )
})

describe('transisi tidak sah', () => {
  test.each(ILLEGAL)(
    '$status + $command ditolak sebagai galat, bukan diabaikan',
    ({ status, command }) => {
      const booking = inState(status)

      const result = applyCommand(booking, validCommand(booking, command))

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toBeInstanceOf(InvalidTransitionError)
      expect(result.error.kind).toBe('invalid_transition')
      expect(result.error.code).toBe('INVALID_BOOKING_TRANSITION')
      expect(result.error.message).toBe(
        `Perintah ${command} tidak berlaku untuk pemesanan berstatus ${status}`,
      )
      expect(result.error.details).toEqual({ bookingId: booking.id, from: status, command })
    },
  )

  test('seluruh seratus sel terbagi habis antara sah dan tidak sah', () => {
    expect(LEGAL.length + ILLEGAL.length).toBe(BOOKING_STATUSES.length * COMMAND_TYPES.length)
    expect(ILLEGAL).toHaveLength(86)
  })
})

describe('keadaan final (NFR-06)', () => {
  /**
   * Dibuktikan dari DUA arah, meniru refund.test.ts di payment-service.
   *
   * Arah pertama saja — "setiap keadaan final tidak punya transisi keluar" —
   * tidak menangkap keadaan tengah yang kehilangan seluruh transisinya: ia
   * menjadi buntu tanpa dinyatakan final, dan pemesanan di sana menggantung
   * selamanya. Arah kedua saja tidak menangkap keadaan final yang diberi
   * transisi keluar. Keduanya bersama menyatakan: tepat keadaan yang disebut
   * final yang tidak punya jalan keluar.
   */
  test('setiap keadaan final tidak punya transisi keluar', () => {
    for (const status of FINAL_STATUSES) {
      expect(allowedCommands(status), status).toEqual([])
      expect(Object.keys(TRANSITIONS[status]), status).toEqual([])
    }
  })

  test('setiap keadaan tanpa transisi keluar dinyatakan final', () => {
    const frozen = BOOKING_STATUSES.filter((status) => allowedCommands(status).length === 0)

    expect([...frozen].sort()).toEqual([...FINAL_STATUSES].sort())
  })

  test('isFinal sepakat dengan daftar keadaan final', () => {
    expect(BOOKING_STATUSES.filter(isFinal).sort()).toEqual([...FINAL_STATUSES].sort())
  })

  /**
   * Jaminan NFR-06 yang sesungguhnya: dari mana pun, selalu ada jalur menuju
   * keadaan final. "Tidak buntu" belum cukup — dua keadaan tengah yang saling
   * menunjuk tanpa jalan keluar tidak buntu, tetapi pemesanan di sana
   * menggantung selamanya. Penelusuran graf menangkap keduanya.
   */
  test.each(BOOKING_STATUSES.filter((status) => !isFinal(status)))(
    'dari %s selalu ada jalur menuju keadaan final',
    (status) => {
      const reachable = [...reachableFrom(status)]

      expect(reachable.some(isFinal), `${status} menjangkau ${reachable.join(', ')}`).toBe(true)
    },
  )

  test('setiap keadaan dapat dicapai dari DRAFT', () => {
    // Keadaan yang tidak dapat dicapai adalah keadaan yang tidak pernah teruji
    // oleh alur sungguhan — dan tanda bahwa tabelnya kehilangan satu sisi.
    expect([...reachableFrom('DRAFT')].sort()).toEqual([...BOOKING_STATUSES].sort())
  })

  test('keadaan final menolak seluruh perintah tanpa mengubah pemesanan', () => {
    for (const status of FINAL_STATUSES) {
      const booking = inState(status)
      const snapshot = structuredClone(booking)

      for (const command of COMMAND_TYPES) {
        expect(applyCommand(booking, validCommand(booking, command)).ok).toBe(false)
      }

      expect(booking).toEqual(snapshot)
    }
  })
})

describe('tabel dan tujuan sepakat', () => {
  test.each(COMMAND_TYPES)(
    'perintah %s dipakai setidaknya di satu keadaan',
    (command: CommandType) => {
      // Perintah yang tidak dipasang di mana pun adalah perintah yang tidak
      // pernah dapat berhasil — kode mati yang terlihat seperti fitur.
      expect(BOOKING_STATUSES.some((status) => allowedCommands(status).includes(command))).toBe(
        true,
      )
    },
  )

  test('pemesanan baru dimulai di DRAFT', () => {
    expect(draft().status).toBe('DRAFT')
  })
})
