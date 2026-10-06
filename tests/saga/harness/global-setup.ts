import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureTopics } from '@tbe/messaging'
import {
  buildImage,
  createDatabases,
  deployMigrations,
  freePort,
  runSeed,
  startKafka,
  startPostgres,
  startRabbit,
  startRedis,
  type Started,
} from '@tbe/testing-infra'
import { GenericContainer, Wait } from 'testcontainers'
import type { TestProject } from 'vitest/node'
import { DATABASES, type InfraInfo } from './context.js'

/**
 * Global setup rangkaian uji saga (Step 20).
 *
 * Seluruh kontainer dinyalakan SEKALI per jalannya Vitest dan dibagikan ke
 * semua berkas uji — menyalakan Kafka dan RabbitMQ per berkas memakan lebih
 * lama daripada skenarionya sendiri. Keadaan dibersihkan antar uji oleh
 * harness/system.ts, bukan dengan membuang kontainernya.
 *
 * Urutannya: kontainer dan citra mock-supplier dibangun BERSAMAAN (yang
 * terakhir paling lama), lalu basis data per service dibuat dan dimigrasikan,
 * lalu seed, lalu topik Kafka. Service aplikasi TIDAK dinyalakan di sini:
 * uji "proses dimatikan di tengah saga" harus dapat membunuh dan menyalakan
 * booking-service, dan itu hanya mungkin dari proses yang memilikinya.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const MOCK_IMAGE = 'tbe-mock-supplier:saga-it'

/**
 * Umur hold di mock-supplier — dan, lewat effectiveHoldUntil, umur hold
 * pemesanan. Cukup pendek supaya skenario "hold kedaluwarsa" dan invarian
 * "tidak ada hold yatim di supplier" tidak menunggu lima belas menit.
 *
 * Cukup PANJANG untuk alur terlambat: konfirmasi setelah `book` kehabisan
 * waktu (15 s) lalu ditanya ulang, dan booking-service yang dibunuh lalu
 * dinyalakan lagi. Versi pertama memakai 20 detik, dan skenario crash
 * berakhir EXPIRED: penyalaan ulang di Windows ditambah rebalance consumer
 * group (anggota lama baru dikeluarkan setelah sesinya habis) melewati umur
 * hold sebelum pembayaran yang sudah masuk sempat dibaca.
 */
export const MOCK_HOLD_TTL_MS = 60_000

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const started: Started[] = []

  // Sebelum kontainer apa pun: kalau build gagal, tidak ada gunanya menunggu
  // Kafka dan RabbitMQ menyala.
  await buildServices()

  try {
    const [postgres, redis, rabbit, kafka, mock] = await Promise.all([
      startPostgres(),
      startRedis(),
      startRabbit(),
      startKafka(),
      startMockSupplier(),
    ])
    started.push(postgres, redis, rabbit, kafka, mock)

    const template = postgres.url('{db}')
    await createDatabases(postgres.url('postgres'), DATABASES)
    await Promise.all(
      DATABASES.map(async (db) => {
        await deployMigrations(join(REPO_ROOT, 'apps', `${db}-service`), url(db))
      }),
    )
    await runSeed(join(REPO_ROOT, 'apps/supplier-service'), {
      DATABASE_URL: url('supplier'),
      SUPPLIER_BASE_URL: mock.url,
    })
    await runSeed(join(REPO_ROOT, 'apps/pricing-service'), { DATABASE_URL: url('pricing') })
    await ensureTopics({ brokers: kafka.brokers, clientId: 'saga-it-setup' })

    const info: InfraInfo = {
      postgresUrlTemplate: template,
      redisUrl: redis.url,
      kafkaBrokers: kafka.brokers,
      rabbitmqUrl: rabbit.url,
      mockSupplier: {
        url: mock.url,
        containerId: mock.container.getId(),
        holdTtlMs: MOCK_HOLD_TTL_MS,
      },
    }
    project.provide('infra', info)

    function url(db: string): string {
      return template.replace('{db}', db)
    }
  } catch (error) {
    await stopAll(started)
    throw error
  }

  return async () => {
    await stopAll(started)
  }
}

/** Service yang dijalankan harness sebagai proses `node dist/index.js`. */
const SPAWNED_SERVICES = [
  '@tbe/booking-service',
  '@tbe/payment-service',
  '@tbe/supplier-service',
  '@tbe/pricing-service',
] as const

/**
 * Membangun keempat service dari SUMBER sebelum satu pun dijalankan.
 *
 * Harness menjalankan `node dist/index.js`, dan tanpa langkah ini yang diuji
 * adalah apa pun yang kebetulan ada di `dist` — bukan kode di repositori.
 * Itu bukan kekhawatiran teoretis. Pada putaran Step 20, `dist` booking-service
 * memuat satu baris yang tidak ada di sumbernya — sisa suntikan cacat yang
 * disunting langsung ke hasil build lalu tidak pernah dikembalikan — dan
 * lima skenario gagal karenanya selama berjam-jam, sementara sumbernya benar.
 *
 * Dua alternatif yang ditolak, dan alasannya:
 *
 * - **Menolak jalan bila `dist` lebih tua dari `src`.** Tidak akan menangkap
 *   kasus di atas: suntingan tangan membuat `dist` LEBIH BARU, bukan lebih
 *   tua. Berkas yang disabotase itu bertanggal sama dengan sumbernya.
 * - **`turbo run build --force`.** Tidak perlu, dan membayar satu menit di
 *   setiap jalan. Cache hit turbo MEMULIHKAN output dari salinan tersimpannya
 *   — dibuktikan dengan menyunting `dist` lalu menjalankan build biasa, dan
 *   suntingannya hilang. Build biasa sudah cukup: detik bila tidak ada yang
 *   berubah, build sungguhan bila ada.
 *
 * `...` pada filter menyertakan paket yang diandalkan — perubahan di
 * `@tbe/money` harus ikut sampai ke service yang memakainya.
 */
async function buildServices(): Promise<void> {
  const filters = SPAWNED_SERVICES.map((name) => `--filter=${name}...`)

  await new Promise<void>((resolveBuild, rejectBuild) => {
    const args = ['exec', 'turbo', 'run', 'build', ...filters]
    // `pnpm` di Windows adalah skrip .cmd, dan spawn tanpa shell tidak dapat
    // menjalankannya. Dengan shell, perintahnya diberikan sebagai SATU string:
    // argumen terpisah bersama `shell: true` hanya digabung tanpa di-escape
    // (Node DEP0190). Seluruh argumennya konstanta di berkas ini.
    const child: ChildProcessWithoutNullStreams =
      process.platform === 'win32'
        ? spawn(['pnpm', ...args].join(' '), { cwd: REPO_ROOT, shell: true })
        : spawn('pnpm', args, { cwd: REPO_ROOT })
    child.stdin.end()
    const output: string[] = []
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString()))
    child.once('error', rejectBuild)
    child.once('exit', (code) => {
      if (code === 0) {
        resolveBuild()
        return
      }
      rejectBuild(
        new Error(
          `build service gagal (kode ${String(code)}); uji tidak dijalankan atas dist yang basi\n` +
            output.join('').slice(-4_000),
        ),
      )
    })
  })
}

interface StartedMock extends Started {
  readonly url: string
}

/**
 * mock-supplier sebagai KONTAINER, dibangun dari Dockerfile-nya sendiri.
 *
 * Port host dipilih lebih dulu dan dipetakan tetap: uji "supplier mati"
 * menghentikan lalu menyalakan kembali kontainer ini, dan port acak Docker
 * dapat berubah pada penyalaan ulang — supplier-service yang sudah berjalan
 * akan terus memanggil alamat lama.
 */
async function startMockSupplier(): Promise<StartedMock> {
  await buildImage({
    context: REPO_ROOT,
    dockerfile: 'apps/mock-supplier/Dockerfile',
    tag: MOCK_IMAGE,
  })
  const hostPort = await freePort()

  const container = await new GenericContainer(MOCK_IMAGE)
    .withEnvironment({
      MOCK_SUPPLIER_INSTANT: 'true',
      MOCK_SUPPLIER_HOLD_TTL_MS: String(MOCK_HOLD_TTL_MS),
      LOG_LEVEL: 'warn',
    })
    .withExposedPorts({ container: 4000, host: hostPort })
    .withWaitStrategy(Wait.forHttp('/health/live', 4000))
    .start()

  // 127.0.0.1, bukan localhost. Di Docker Desktop Windows, `localhost`
  // diselesaikan ke ::1 lebih dulu, dan port IPv6 itu dipegang penerus
  // wslrelay yang tetap mendengarkan sebentar setelah kontainer berhenti —
  // menerima koneksi lalu memutusnya. "Supplier mati" lalu tampak sebagai
  // koneksi yang putus (tidak pasti), bukan ditolak (lihat stopContainer).
  return { container, url: `http://127.0.0.1:${String(hostPort)}` }
}

async function stopAll(started: readonly Started[]): Promise<void> {
  await Promise.allSettled(started.map(async (item) => await item.container.stop()))
}
