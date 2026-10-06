import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Batas waktu build: build pertama mengunduh citra dasar dan memasang dependensi. */
const BUILD_TIMEOUT_MS = 15 * 60_000

/**
 * Membangun citra lewat CLI `docker build`, bukan `GenericContainer.fromDockerfile`.
 *
 * Alternatif yang ditolak justru yang pertama dicoba: pembangun Testcontainers
 * menelusuri SELURUH konteks — termasuk node_modules pnpm, ratusan ribu berkas
 * — sebelum menerapkan .dockerignore. Di Windows, penelusuran itu saja memakan
 * waktu lebih dari sepuluh menit, dan global setup kehabisan waktu sebelum satu
 * pun uji berjalan. BuildKit di balik CLI menerapkan .dockerignore sebelum
 * membaca konteks, dan cache lapisannya membuat build ulang tanpa perubahan
 * selesai dalam hitungan detik.
 */
export async function buildImage(options: {
  readonly context: string
  readonly dockerfile: string
  readonly tag: string
}): Promise<string> {
  await run('docker', ['build', '-f', options.dockerfile, '-t', options.tag, '.'], {
    cwd: options.context,
    timeout: BUILD_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  })
  return options.tag
}
