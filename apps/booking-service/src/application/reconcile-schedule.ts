import { createHash } from 'node:crypto'
import type { SupplierCode } from '../domain/booking.js'

/**
 * Jadwal rekonsiliasi (Step 28): satu putaran per slot waktu, berapa pun
 * instance booking-service yang menyala.
 *
 * Setiap instance menjalankan penjadwal yang sama dan mengirim
 * `reconciliation.run` untuk slot yang sedang berjalan. Pengenal pesannya
 * DITURUNKAN dari awal slot, jadi tiga instance mengirim tiga pesan dengan
 * pengenal yang sama — dan baris `reconciliation_runs` berkunci pengenal itu
 * menjadikannya satu putaran. Yang lain menemukan putarannya sudah selesai.
 *
 * Alternatif yang ditolak:
 *
 * - Kunci penasihat Postgres di penjadwal. Mencegah pengiriman ganda, tetapi
 *   bukan pemrosesan ganda: RabbitMQ tetap dapat mengirim ulang pesan yang
 *   ack-nya hilang. Penyatuan di sisi consumer tetap dibutuhkan, dan dengan
 *   itu kuncinya tidak menambah apa pun.
 * - Penjadwal di luar service (cron Kubernetes). Satu komponen lagi untuk
 *   dikerahkan dan dipantau, untuk pekerjaan yang dapat diatur di sini.
 *
 * Slot yang terlewat — RabbitMQ mati tepat saat slot berganti — tidak
 * dikejar. Setiap putaran memeriksa SELURUH jendelanya, bukan selisih sejak
 * putaran sebelumnya, jadi slot berikutnya menutupnya; yang hilang hanya
 * keterlambatan satu selang.
 */

export interface Slot {
  readonly startedAt: Date
  /** Hari UTC awal slot: nilai `date` perintah `reconciliation.run`. */
  readonly day: string
  readonly runId: string
}

export function slotAt(now: Date, intervalMs: number): Slot {
  const startedAt = new Date(Math.floor(now.getTime() / intervalMs) * intervalMs)
  return {
    startedAt,
    day: startedAt.toISOString().slice(0, 10),
    runId: runIdFor(startedAt),
  }
}

/**
 * UUID versi 8 (RFC 9562: "khusus vendor") dari SHA-256 awal slot. Bukan v4
 * acak — itulah intinya — dan bukan v5, yang menuntut namespace UUID dan SHA-1
 * tanpa memberi apa pun yang dibutuhkan di sini. Bit versi dan varian dipasang
 * supaya validasi `z.uuid()` di kontrak pesan menerimanya.
 */
export function runIdFor(slotStartedAt: Date): string {
  const bytes = createHash('sha256')
    .update(`reconciliation.run:${slotStartedAt.toISOString()}`)
    .digest()
    .subarray(0, 16)
  bytes.writeUInt8(((bytes.readUInt8(6) & 0x0f) | 0x80) >>> 0, 6)
  bytes.writeUInt8(((bytes.readUInt8(8) & 0x3f) | 0x80) >>> 0, 8)
  const hex = bytes.toString('hex')

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Pengiriman `reconciliation.run`. Dipasang di composition root di atas pengirim perintah. */
export interface ReconciliationRequests {
  request(run: {
    readonly id: string
    readonly day: string
    readonly supplier?: SupplierCode | undefined
  }): Promise<void>
}

/**
 * Satu detak penjadwal. Dipanggil jauh lebih sering dari selang slotnya —
 * setiap menit — dan hanya mengirim saat slotnya berganti. Instance yang
 * baru menyala mengirim slot yang sedang berjalan pada detak pertamanya;
 * bila putaran slot itu sudah selesai di instance lain, consumer
 * menjawabnya `already_finished`.
 *
 * Slot dicatat terkirim HANYA setelah pengiriman berhasil: RabbitMQ yang mati
 * membuat detak berikutnya mencoba lagi, bukan melewatkan slotnya.
 */
export function createScheduler(options: {
  readonly requests: ReconciliationRequests
  readonly intervalMs: number
  readonly now: () => Date
}): { tick(): Promise<Slot | undefined> } {
  let sent: string | undefined

  return {
    async tick() {
      const slot = slotAt(options.now(), options.intervalMs)
      if (slot.runId === sent) return undefined

      await options.requests.request({ id: slot.runId, day: slot.day })
      sent = slot.runId
      return slot
    },
  }
}
