/**
 * Pemutus sirkuit, sebagai mesin keadaan murni.
 *
 * Tidak ada Redis di berkas ini, tidak ada waktu yang dibaca sendiri, tidak
 * ada I/O. Yang ada hanya: diberi hitungan sekarang dan satu hasil panggilan,
 * keadaan berikutnya apa. Itulah yang membuat seluruh perilakunya — termasuk
 * pemulihan bertahap yang paling sulit diuji — dapat dibuktikan tanpa satu
 * proses pun berjalan.
 *
 * Hitungannya sendiri disimpan di Redis, bukan di memori proses. Pemutus yang
 * hitungannya per-instance membuat sepuluh replika masing-masing harus belajar
 * sendiri bahwa supplier sedang mati, dan selama proses belajar itu setiap
 * replika masih menembak supplier yang sudah jelas tumbang.
 */

export const CIRCUIT_STATES = ['closed', 'open', 'half_open'] as const
export type CircuitState = (typeof CIRCUIT_STATES)[number]

export interface CircuitPolicy {
  /** Kegagalan berturut-turut di dalam jendela sebelum pemutus terbuka. */
  readonly failureThreshold: number
  /** Panjang jendela penghitungan. */
  readonly windowMs: number
  /** Berapa lama pemutus tetap terbuka sebelum satu percobaan diizinkan. */
  readonly openDurationMs: number
  /**
   * Keberhasilan berturut-turut saat setengah terbuka sebelum ditutup penuh.
   *
   * Lebih dari satu dengan sengaja: supplier yang baru pulih kerap berhasil
   * sekali lalu gagal lagi, dan menutup pemutus setelah satu keberhasilan
   * mengirimkan seluruh trafik kembali ke supplier yang belum benar-benar
   * pulih.
   */
  readonly successesToClose: number
}

export const DEFAULT_CIRCUIT_POLICY: CircuitPolicy = {
  failureThreshold: 5,
  windowMs: 60_000,
  openDurationMs: 30_000,
  successesToClose: 2,
}

/**
 * Keadaan yang tersimpan.
 *
 * Sengaja hanya berisi angka dan cap waktu — tidak ada objek, tidak ada
 * fungsi — supaya dapat disimpan apa adanya sebagai hash di Redis dan
 * dioperasikan secara atomik.
 */
export interface CircuitRecord {
  readonly state: CircuitState
  readonly failures: number
  readonly successes: number
  /** Cap waktu kegagalan pertama dalam jendela berjalan. */
  readonly windowStartedAtMs: number
  /** Cap waktu pemutus terakhir kali terbuka. */
  readonly openedAtMs: number
}

export const CLOSED_CIRCUIT: CircuitRecord = {
  state: 'closed',
  failures: 0,
  successes: 0,
  windowStartedAtMs: 0,
  openedAtMs: 0,
}

export type CircuitDecision =
  | { readonly allowed: true; readonly state: CircuitState }
  /** Ditolak tanpa menyentuh supplier sama sekali. */
  | { readonly allowed: false; readonly state: 'open'; readonly retryAfterMs: number }

/**
 * Apakah panggilan boleh berjalan.
 *
 * Pemutus yang terbuka melewati durasinya TIDAK langsung menjadi tertutup.
 * Ia menjadi setengah terbuka: satu panggilan diizinkan lewat sebagai
 * percobaan, dan keadaan berikutnya ditentukan hasil percobaan itu. Langsung
 * menutupnya berarti mengirim seluruh trafik ke supplier yang belum tentu
 * pulih, dan pemutusnya membuka lagi seketika — berayun tanpa henti.
 */
export function decide(
  record: CircuitRecord,
  policy: CircuitPolicy,
  nowMs: number,
): CircuitDecision {
  if (record.state === 'closed') return { allowed: true, state: 'closed' }

  if (record.state === 'half_open') return { allowed: true, state: 'half_open' }

  const elapsed = nowMs - record.openedAtMs
  if (elapsed >= policy.openDurationMs) return { allowed: true, state: 'half_open' }

  return { allowed: false, state: 'open', retryAfterMs: policy.openDurationMs - elapsed }
}

export interface Transition {
  readonly record: CircuitRecord
  /** Diisi hanya ketika keadaan benar-benar berubah, untuk peristiwa Kafka. */
  readonly changedTo?: CircuitState
}

export function afterSuccess(
  record: CircuitRecord,
  policy: CircuitPolicy,
  nowMs: number,
): Transition {
  const observed = observedState(record, policy, nowMs)

  if (observed === 'half_open') {
    const successes = record.successes + 1
    if (successes < policy.successesToClose) {
      return { record: { ...record, state: 'half_open', successes, failures: 0 } }
    }

    return { record: CLOSED_CIRCUIT, changedTo: 'closed' }
  }

  // Keberhasilan saat tertutup mengosongkan hitungan kegagalan. Kegagalan
  // yang terpisah jauh oleh keberhasilan bukan pola kegagalan — itu hanya
  // kebisingan biasa, dan pemutus tidak boleh membukanya.
  return { record: CLOSED_CIRCUIT }
}

export function afterFailure(
  record: CircuitRecord,
  policy: CircuitPolicy,
  nowMs: number,
): Transition {
  const observed = observedState(record, policy, nowMs)

  if (observed === 'half_open') {
    // Percobaan gagal: kembali terbuka penuh, dan hitungan waktunya dimulai
    // dari sekarang, bukan dari pembukaan sebelumnya.
    return {
      record: {
        ...CLOSED_CIRCUIT,
        state: 'open',
        failures: policy.failureThreshold,
        openedAtMs: nowMs,
      },
      changedTo: 'open',
    }
  }

  if (observed === 'open') return { record }

  const inWindow = nowMs - record.windowStartedAtMs < policy.windowMs
  const failures = inWindow ? record.failures + 1 : 1
  const windowStartedAtMs =
    inWindow && record.windowStartedAtMs > 0 ? record.windowStartedAtMs : nowMs

  if (failures >= policy.failureThreshold) {
    return {
      record: { ...CLOSED_CIRCUIT, state: 'open', failures, openedAtMs: nowMs },
      changedTo: 'open',
    }
  }

  return { record: { state: 'closed', failures, successes: 0, windowStartedAtMs, openedAtMs: 0 } }
}

/**
 * Keadaan yang sebenarnya berlaku sekarang.
 *
 * Berbeda dari `record.state` ketika pemutus terbuka sudah melewati
 * durasinya: yang tersimpan masih `open`, tetapi yang berlaku adalah
 * `half_open`. Perbedaan itu tidak disimpan supaya tidak ada penulisan ke
 * Redis hanya karena waktu berjalan.
 */
export function observedState(
  record: CircuitRecord,
  policy: CircuitPolicy,
  nowMs: number,
): CircuitState {
  if (record.state !== 'open') return record.state

  return nowMs - record.openedAtMs >= policy.openDurationMs ? 'half_open' : record.state
}

/** Nilai numerik untuk metrik `supplier_circuit_state`. */
export function circuitStateValue(state: CircuitState): number {
  switch (state) {
    case 'closed':
      return 0
    case 'half_open':
      return 1
    case 'open':
      return 2
  }
}
