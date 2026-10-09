import { describe, expect, test } from 'vitest'
import { draft, inState, sampleFor, validCommand } from '../testing/builders.js'
import { BOOKING_STATUSES, FINAL_STATUSES, isFinal, type BookingStatus } from './booking.js'
import { COMMAND_TARGETS, COMMAND_TYPES, type CommandType } from './commands.js'
import { InvalidTransitionError } from './errors.js'
import {
  TRANSITIONS,
  USER_INITIATED_COMMANDS,
  allowedCommands,
  applyCommand,
  isUserInitiated,
} from './transitions.js'

/**
 * Sifat tabel transisi.
 *
 * Seluruh uji di berkas ini bekerja atas SELURUH ruang keadaan — sebelas
 * keadaan kali empat belas perintah — bukan atas contoh pilihan. Sel yang tidak
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
  test('tepat sembilan belas transisi yang disepakati', () => {
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
        // Step 25: pembatalan oleh pengguna setelah terkonfirmasi.
        'CONFIRMED -requestCancellation-> CANCELLING',
        'CANCELLING -confirmSupplierCancellation-> CANCELLING',
        'CANCELLING -completeCancellation-> CANCELLED',
        'CANCELLING -restoreConfirmation-> CONFIRMED',
        'CANCELLING -requireReview-> NEEDS_REVIEW',
      ].sort(),
    )
    // Sel yang berujung di keadaan yang sama dihitung terpisah per perintah,
    // karena aturannya berbeda: verifyPrice dan acceptPrice, dan dua langkah
    // di dalam CANCELLING.
    expect(LEGAL).toHaveLength(19)
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

  test('seluruh sel terbagi habis antara sah dan tidak sah', () => {
    expect(LEGAL.length + ILLEGAL.length).toBe(BOOKING_STATUSES.length * COMMAND_TYPES.length)
    expect(ILLEGAL).toHaveLength(11 * 14 - 19)
  })
})

describe('keadaan final (NFR-06)', () => {
  /**
   * Dibuktikan dari DUA arah, meniru refund.test.ts di payment-service.
   *
   * "Transisi keluar" di sini berarti transisi yang dijalankan SISTEM. Sejak
   * Step 25 CONFIRMED punya satu jalan keluar milik pengguna —
   * `requestCancellation` — dan tetap final bagi saga dan NFR-06 (ADR-0004).
   *
   * Arah pertama saja — "setiap keadaan final tidak punya transisi keluar" —
   * tidak menangkap keadaan tengah yang kehilangan seluruh transisinya: ia
   * menjadi buntu tanpa dinyatakan final, dan pemesanan di sana menggantung
   * selamanya. Arah kedua saja tidak menangkap keadaan final yang diberi
   * transisi keluar. Keduanya bersama menyatakan: tepat keadaan yang disebut
   * final yang tidak punya jalan keluar.
   */
  test('setiap keadaan final tidak punya transisi keluar selain permintaan pengguna', () => {
    for (const status of FINAL_STATUSES) {
      const systemCommands = allowedCommands(status).filter((command) => !isUserInitiated(command))

      expect(systemCommands, status).toEqual([])
    }
  })

  test('setiap keadaan tanpa transisi keluar sistem dinyatakan final', () => {
    const frozen = BOOKING_STATUSES.filter((status) =>
      allowedCommands(status).every((command) => isUserInitiated(command)),
    )

    expect([...frozen].sort()).toEqual([...FINAL_STATUSES].sort())
  })

  test('satu-satunya jalan keluar milik pengguna adalah pembatalan dari CONFIRMED', () => {
    const userExits = FINAL_STATUSES.flatMap((status) =>
      allowedCommands(status).map((command) => `${status} -${command}`),
    )

    expect(userExits).toEqual(['CONFIRMED -requestCancellation'])
    expect(USER_INITIATED_COMMANDS).toEqual(['requestCancellation'])
    expect(Object.keys(TRANSITIONS.REFUNDED)).toEqual([])
  })

  test('perintah milik pengguna tidak pernah dipasang pada keadaan yang digerakkan saga', () => {
    // CANCELLING dan keadaan tengah lain digerakkan peristiwa dan batas waktu.
    // Perintah pengguna di sana berarti dua penggerak yang saling menimpa.
    for (const status of BOOKING_STATUSES.filter((candidate) => !isFinal(candidate))) {
      expect(allowedCommands(status).filter(isUserInitiated), status).toEqual([])
    }
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

  test('keadaan final menolak seluruh perintah sistem tanpa mengubah pemesanan', () => {
    for (const status of FINAL_STATUSES) {
      const booking = inState(status)
      const snapshot = structuredClone(booking)

      for (const command of COMMAND_TYPES.filter((candidate) => !isUserInitiated(candidate))) {
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
