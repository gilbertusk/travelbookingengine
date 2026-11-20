/**
 * Ringkasan kesehatan supplier dari catatan percobaan (Step 27, FR-31).
 *
 * Murni: diberi sampel, mengembalikan angka. Sumber sampelnya tabel
 * `supplier_requests`, yang sudah mencatat setiap percobaan sejak Step 11 —
 * panel operator tidak menambah pengukuran baru, hanya membacanya.
 *
 * Alternatif yang ditolak: membaca histogram Prometheus. Angkanya ada di sana,
 * tetapi panel operator lalu bergantung pada Prometheus yang menyala dan dapat
 * dijangkau dari service — dan di tingkat gratis Step 30 Prometheus mungkin
 * tidak ada sama sekali.
 */

export interface RequestSample {
  readonly outcome: 'success' | 'failure'
  readonly latencyMs: number
}

export interface RequestStats {
  readonly attempts: number
  readonly failures: number
  /** Dalam basis poin (0–10_000), bukan pecahan — konsisten dengan markup. */
  readonly errorRateBasisPoints: number
  /** null bila tidak ada sampel: "0 ms" akan berbohong tentang supplier yang diam. */
  readonly latencyP50Ms: number | null
  readonly latencyP95Ms: number | null
}

const BASIS_POINTS = 10_000

export function summarizeRequests(samples: readonly RequestSample[]): RequestStats {
  const failures = samples.filter((sample) => sample.outcome === 'failure').length
  const latencies = samples.map((sample) => sample.latencyMs).toSorted((a, b) => a - b)

  return {
    attempts: samples.length,
    failures,
    errorRateBasisPoints:
      samples.length === 0 ? 0 : Math.round((failures * BASIS_POINTS) / samples.length),
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
  }
}

/**
 * Persentil metode peringkat terdekat atas larik yang SUDAH terurut.
 *
 * Bukan interpolasi: angka yang dilaporkan selalu latensi yang benar-benar
 * pernah terjadi, yang lebih jujur untuk sampel kecil — lima permintaan tidak
 * punya "p95 = 812,4 ms".
 */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null

  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? null
}
