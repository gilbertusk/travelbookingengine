import { mkdir, writeFile } from 'node:fs/promises'
import { EOL } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { freePort } from '@tbe/testing-infra'
import pg from 'pg'
import { databaseUrl, infra, type InfraInfo } from './context.js'
import { startMidtransStub, type MidtransStub } from './midtrans-stub.js'
import { startService, type ServiceProcess, type ServiceSpec } from './processes.js'
import { createSupplierControl, type SupplierControl } from './supplier-control.js'

/**
 * Seluruh sistem yang diuji: empat service aplikasi sebagai proses OS, di
 * atas kontainer dari global setup, ditambah pengganti Midtrans.
 *
 * Satu sistem per berkas uji. Service dinyalakan ulang per berkas supaya
 * proses yang dibunuh di satu berkas tidak mewariskan apa pun ke berkas lain;
 * kontainernya tetap sama (lihat global-setup.ts).
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/**
 * Batas waktu booking-service untuk uji. Semuanya melewati pemeriksaan
 * config.ts yang sama dengan produksi — nilai yang ditolak di sana ditolak
 * juga di sini, dan startup-nya gagal keras.
 */
export const BOOKING_TIMINGS = {
  UPSTREAM_TIMEOUT_MS: '4000',
  // Harus lebih dari tiga kali UPSTREAM_TIMEOUT_MS (config.ts).
  SAGA_STEP_LEASE_MS: '13000',
  // Harus lebih dari jenjang retry perintah (5 s + 30 s + 2 m = 155 s) —
  // config.ts menolak yang tidak. Dilebihkan 45 s: dead letter setelah jenjang
  // habis masih harus melintasi Kafka sebelum saga membacanya, dan batas yang
  // terlalu mepet membuat "supplier menolak" kalah balapan dengan "tidak ada
  // jawaban" di mesin CI yang lambat.
  SAGA_CONFIRM_TIMEOUT_MS: '200000',
  SAGA_REFUND_TIMEOUT_MS: '200000',
  SAGA_COMPENSATION_MAX_ATTEMPTS: '3',
  SAGA_COMPENSATION_RETRY_MS: '1000',
  SAGA_SWEEP_INTERVAL_MS: '1000',
  HOLD_SWEEP_INTERVAL_MS: '1000',
  OUTBOX_POLL_INTERVAL_MS: '100',
  STATUS_STREAM_POLL_MS: '200',
  STATUS_STREAM_HEARTBEAT_MS: '5000',
} as const

export interface System {
  readonly infra: InfraInfo
  readonly booking: ServiceProcess
  readonly payment: ServiceProcess
  readonly supplierService: ServiceProcess
  readonly pricing: ServiceProcess
  readonly midtrans: MidtransStub
  readonly supplier: SupplierControl
  readonly db: { readonly booking: pg.Pool; readonly payment: pg.Pool }
  /** Membunuh booking-service dengan SIGKILL. */
  killBooking(): Promise<void>
  /** Menyalakan booking-service baru di atas basis data, Redis, dan broker yang sama. */
  restartBooking(): Promise<void>
  /** Membersihkan keadaan yang dapat dibersihkan, di antara uji. */
  reset(): Promise<void>
  /**
   * Menulis log keempat service ke tests/saga/.logs/ — dipanggil saat uji
   * gagal. Uji lintas proses yang gagal tanpa log hanya menyisakan "tidak
   * pernah CONFIRMED", dan jawabannya ada di service lain.
   */
  dumpLogs(label: string): Promise<string>
  stop(): Promise<void>
}

export async function startSystem(): Promise<System> {
  const env = infra()
  const midtrans = await startMidtransStub()
  const [pricingPort, supplierPort, paymentPort, bookingPort] = await Promise.all([
    freePort(),
    freePort(),
    freePort(),
    freePort(),
  ])
  const url = (db: 'booking' | 'payment' | 'supplier' | 'pricing') =>
    databaseUrl(env.postgresUrlTemplate, db)

  const common = {
    REDIS_URL: env.redisUrl,
    KAFKA_BROKERS: env.kafkaBrokers.join(','),
    RABBITMQ_URL: env.rabbitmqUrl,
  }

  const first = [
    startService(spec('pricing-service', pricingPort, { ...common, DATABASE_URL: url('pricing') })),
    startService(
      spec('supplier-service', supplierPort, {
        ...common,
        DATABASE_URL: url('supplier'),
        SUPPLIER_BASE_URL: env.mockSupplier.url,
      }),
    ),
    startService(
      spec('payment-service', paymentPort, {
        ...common,
        DATABASE_URL: url('payment'),
        MIDTRANS_SERVER_KEY: midtrans.serverKey,
        MIDTRANS_CLIENT_KEY: 'SB-Mid-client-saga-it',
        MIDTRANS_SNAP_BASE_URL: midtrans.url,
        MIDTRANS_API_BASE_URL: midtrans.url,
      }),
    ),
  ] as const
  await settleOrCleanUp(midtrans, first)
  const [pricing, supplierService, payment] = await Promise.all(first)

  const bookingSpec = spec('booking-service', bookingPort, {
    ...common,
    // debug: log "peristiwa saga diproses" membawa hasil tiap pesan —
    // `duplicate` di sana adalah bukti skenario pengiriman ulang.
    LOG_LEVEL: 'debug',
    ...BOOKING_TIMINGS,
    DATABASE_URL: url('booking'),
    SUPPLIER_SERVICE_URL: supplierService.url,
    PRICING_SERVICE_URL: pricing.url,
    PAYMENT_SERVICE_URL: payment.url,
  })
  const bookingStart = startService(bookingSpec)
  await settleOrCleanUp(midtrans, [bookingStart], [pricing, supplierService, payment])
  let booking = await bookingStart

  const db = {
    booking: new pg.Pool({ connectionString: url('booking'), max: 4 }),
    payment: new pg.Pool({ connectionString: url('payment'), max: 4 }),
  }
  const supplier = createSupplierControl(env.mockSupplier)
  await supplier.reset()

  return {
    infra: env,
    get booking() {
      return booking
    },
    payment,
    supplierService,
    pricing,
    midtrans,
    supplier,
    db,
    async killBooking() {
      await booking.kill()
    },
    async restartBooking() {
      await booking.kill()
      booking = await startService(bookingSpec)
    },
    async reset() {
      midtrans.reset()
      await supplier.ensureRunning()
      await supplier.reset()
    },
    async dumpLogs(label) {
      const dir = join(REPO_ROOT, 'tests/saga/.logs')
      await mkdir(dir, { recursive: true })
      const file = join(dir, `${label.replace(/[^a-z0-9]+/gi, '-').slice(0, 80)}.log`)
      const sections = [booking, payment, supplierService, pricing].map((service) =>
        [`==== ${service.name}`, ...service.logs.map((line) => JSON.stringify(line.raw))].join(EOL),
      )
      await writeFile(file, sections.join(EOL + EOL), 'utf8')
      return file
    },
    async stop() {
      await Promise.allSettled([booking, payment, supplierService, pricing].map((p) => p.stop()))
      await Promise.allSettled([db.booking.end(), db.payment.end(), midtrans.close()])
    },
  }
}

/**
 * Menunggu sekelompok service menyala. Bila SATU gagal, seluruhnya —
 * termasuk yang sudah menyala lebih dulu (`running`) — dimatikan sebelum
 * galatnya dilempar.
 *
 * Tanpa ini, berkas uji yang gagal di `beforeAll` meninggalkan proses node
 * yatim yang terus memegang port, koneksi Postgres, dan consumer group Kafka
 * sampai rangkaian selesai — ditemukan putaran Step 20, ketika satu
 * booking-service yang gagal menyala meninggalkan tiga service lain berjalan
 * di bawah berkas berikutnya.
 */
async function settleOrCleanUp(
  midtrans: MidtransStub,
  starting: readonly Promise<ServiceProcess>[],
  running: readonly ServiceProcess[] = [],
): Promise<void> {
  const results = await Promise.allSettled(starting)
  const failure = results.find((result) => result.status === 'rejected')
  if (failure === undefined) return

  const started = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
  await Promise.allSettled(
    [...running, ...started].map(async (service) => {
      await service.kill()
    }),
  )
  await midtrans.close()
  throw failure.reason
}

function spec(name: string, port: number, env: Record<string, string>): ServiceSpec {
  return { name, appDir: join(REPO_ROOT, 'apps', name), port, env }
}
