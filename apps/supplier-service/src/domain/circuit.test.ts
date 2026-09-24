import { describe, expect, test } from 'vitest'
import {
  CLOSED_CIRCUIT,
  afterFailure,
  afterSuccess,
  circuitStateValue,
  decide,
  DEFAULT_CIRCUIT_POLICY,
  observedState,
  type CircuitPolicy,
  type CircuitRecord,
} from './circuit.js'

/**
 * Mesin keadaan pemutus.
 *
 * Seluruh perilaku berbasis waktu diuji dengan cap waktu yang diberikan, bukan
 * dengan menunggu. Pengujian yang benar-benar menunggu tiga puluh detik untuk
 * membuktikan pemulihan adalah pengujian yang akan dimatikan orang, dan
 * pemulihan bertahap justru bagian yang paling sering salah.
 */

const POLICY: CircuitPolicy = {
  failureThreshold: 3,
  windowMs: 10_000,
  openDurationMs: 5_000,
  successesToClose: 2,
}

const T0 = 1_000_000

/**
 * Seluruh kegagalan pada cap waktu yang sama.
 *
 * Menggesernya per iterasi membuat `openedAtMs` ikut bergeser, dan pengujian
 * pemulihan yang menghitung dari T0 meleset beberapa milidetik — cukup untuk
 * membuat durasi terbuka tidak pernah terlewati.
 */
function failTimes(count: number, policy = POLICY, atMs = T0): CircuitRecord {
  let record = CLOSED_CIRCUIT

  for (let index = 0; index < count; index += 1) {
    record = afterFailure(record, policy, atMs).record
  }

  return record
}

describe('membuka setelah ambang tercapai', () => {
  test('kegagalan di bawah ambang membiarkan pemutus tertutup', () => {
    const record = failTimes(2)

    expect(record.state).toBe('closed')
    expect(decide(record, POLICY, T0).allowed).toBe(true)
  })

  test('kegagalan yang mencapai ambang membuka pemutus', () => {
    const record = failTimes(3)

    expect(record.state).toBe('open')
    expect(decide(record, POLICY, T0).allowed).toBe(false)
  })

  test('pembukaan dilaporkan sekali, bukan pada setiap kegagalan berikutnya', () => {
    // Menerbitkan peristiwa pada setiap kegagalan akan membanjiri topik
    // dengan ribuan pesan yang mengatakan hal yang sama.
    const opened = afterFailure(failTimes(2), POLICY, T0)
    expect(opened.changedTo).toBe('open')

    const again = afterFailure(opened.record, POLICY, T0 + 1)
    expect(again.changedTo).toBeUndefined()
  })

  test('kegagalan yang terpisah lebih jauh dari jendela tidak menumpuk', () => {
    // Dua kegagalan pada hari yang berbeda bukan pola kegagalan.
    let record = afterFailure(CLOSED_CIRCUIT, POLICY, T0).record
    record = afterFailure(record, POLICY, T0 + POLICY.windowMs + 1).record

    expect(record.failures).toBe(1)
    expect(record.state).toBe('closed')
  })

  test('keberhasilan mengosongkan hitungan kegagalan', () => {
    // Kegagalan yang diselingi keberhasilan adalah kebisingan biasa, bukan
    // supplier yang tumbang.
    let record = failTimes(2)
    record = afterSuccess(record, POLICY, T0).record

    expect(record.failures).toBe(0)
    expect(afterFailure(record, POLICY, T0).record.state).toBe('closed')
  })
})

describe('menolak tanpa menyentuh jaringan', () => {
  test('pemutus terbuka menolak dan menyebutkan sisa waktunya', () => {
    const record = failTimes(3)
    const decision = decide(record, POLICY, T0 + 2_000)

    expect(decision.allowed).toBe(false)
    if (decision.allowed) return
    expect(decision.retryAfterMs).toBeGreaterThan(0)
    expect(decision.retryAfterMs).toBeLessThanOrEqual(POLICY.openDurationMs)
  })

  test('inilah yang membuat supplier mati tidak menurunkan latensi', () => {
    // Penolakan terjadi dari catatan, tanpa memanggil apa pun — itu sebabnya
    // NFR-03 dapat dipenuhi: ditolak dalam mikrodetik, bukan setelah
    // menunggu batas waktu.
    const record = failTimes(3)

    expect(decide(record, POLICY, T0).allowed).toBe(false)
  })
})

describe('pemulihan bertahap', () => {
  test('setelah durasinya lewat, satu percobaan diizinkan', () => {
    const record = failTimes(3)
    const decision = decide(record, POLICY, T0 + POLICY.openDurationMs)

    expect(decision.allowed).toBe(true)
    expect(decision.state).toBe('half_open')
  })

  test('keadaan setengah terbuka tidak ditulis hanya karena waktu berjalan', () => {
    // Menulis ke Redis setiap kali waktu lewat berarti satu penulisan per
    // pembacaan, untuk keadaan yang dapat dihitung dari cap waktu.
    const record = failTimes(3)

    expect(record.state).toBe('open')
    expect(observedState(record, POLICY, T0 + POLICY.openDurationMs)).toBe('half_open')
  })

  test('satu keberhasilan belum menutup pemutus', () => {
    // Supplier yang baru pulih kerap berhasil sekali lalu gagal lagi.
    const open = failTimes(3)
    const first = afterSuccess(open, POLICY, T0 + POLICY.openDurationMs)

    expect(first.record.state).toBe('half_open')
    expect(first.changedTo).toBeUndefined()
  })

  test('keberhasilan kedua menutup pemutus dan melaporkan pemulihan', () => {
    const open = failTimes(3)
    const first = afterSuccess(open, POLICY, T0 + POLICY.openDurationMs)
    const second = afterSuccess(first.record, POLICY, T0 + POLICY.openDurationMs + 10)

    expect(second.record.state).toBe('closed')
    expect(second.changedTo).toBe('closed')
  })

  test('percobaan yang gagal mengembalikan pemutus ke terbuka penuh', () => {
    const open = failTimes(3)
    const probe = afterFailure(open, POLICY, T0 + POLICY.openDurationMs)

    expect(probe.record.state).toBe('open')
    expect(probe.changedTo).toBe('open')
  })

  test('hitungan waktu dimulai ulang setelah percobaan yang gagal', () => {
    // Kalau tidak, pemutus akan langsung setengah terbuka lagi pada
    // pemeriksaan berikutnya, dan supplier yang tumbang ditembak terus.
    const open = failTimes(3)
    const probeAt = T0 + POLICY.openDurationMs
    const probe = afterFailure(open, POLICY, probeAt)

    expect(decide(probe.record, POLICY, probeAt + 1).allowed).toBe(false)
    expect(decide(probe.record, POLICY, probeAt + POLICY.openDurationMs).allowed).toBe(true)
  })
})

describe('nilai bawaan dan metrik', () => {
  test('kebijakan bawaan masuk akal untuk supplier nyata', () => {
    expect(DEFAULT_CIRCUIT_POLICY.failureThreshold).toBeGreaterThan(1)
    expect(DEFAULT_CIRCUIT_POLICY.successesToClose).toBeGreaterThan(1)
    expect(DEFAULT_CIRCUIT_POLICY.openDurationMs).toBeGreaterThan(0)
  })

  test('keadaan dipetakan ke angka untuk Prometheus', () => {
    expect(circuitStateValue('closed')).toBe(0)
    expect(circuitStateValue('half_open')).toBe(1)
    expect(circuitStateValue('open')).toBe(2)
  })

  test('keadaan tertutup dan setengah terbuka dilaporkan apa adanya', () => {
    expect(observedState(CLOSED_CIRCUIT, POLICY, T0)).toBe('closed')
    expect(observedState({ ...CLOSED_CIRCUIT, state: 'half_open' }, POLICY, T0)).toBe('half_open')
  })
})
