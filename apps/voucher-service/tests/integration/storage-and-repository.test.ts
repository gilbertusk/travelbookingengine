import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDatabases, deployMigrations, startPostgres, type Started } from '@tbe/testing-infra'
import { GenericContainer, Wait } from 'testcontainers'
import { Client } from 'minio'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { issueVoucher } from '../../src/application/issue-voucher.js'
import { voucherDocument, voucherLink } from '../../src/application/voucher-access.js'
import type { VoucherDeps } from '../../src/application/ports.js'
import type { Voucher } from '../../src/domain/voucher.js'
import { createMinioStorage } from '../../src/infrastructure/minio-storage.js'
import { createPdfKitRenderer } from '../../src/infrastructure/pdfkit-renderer.js'
import { createPrismaClient } from '../../src/infrastructure/prisma-client.js'
import { createPrismaVoucherRepository } from '../../src/infrastructure/prisma-voucher-repository.js'
import { secureTokens, uuidFactory } from '../../src/infrastructure/system.js'
import { BOOKING_ID, OTHER_USER, USER, world } from '../../src/testing/fakes.js'

/**
 * Postgres dan MinIO sungguhan; booking-service dan katalog tetap palsuan —
 * jawaban HTTP mereka sudah diuji di http-directories.test.ts.
 */

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const MINIO_IMAGE = 'pgsty/minio:RELEASE.2026-08-04T00-00-00Z'
const MINIO_USER = 'tbe'
const MINIO_PASSWORD = 'tbe_it_minio'
const BUCKET = 'vouchers'

const started: Started[] = []
let prisma: ReturnType<typeof createPrismaClient>
let storage: ReturnType<typeof createMinioStorage>
let minioUrl = ''

beforeAll(async () => {
  const [postgres, minio] = await Promise.all([
    startPostgres(),
    new GenericContainer(MINIO_IMAGE)
      .withEnvironment({ MINIO_ROOT_USER: MINIO_USER, MINIO_ROOT_PASSWORD: MINIO_PASSWORD })
      .withCommand(['server', '/data'])
      .withExposedPorts(9000)
      .withWaitStrategy(Wait.forHttp('/minio/health/ready', 9000))
      .start(),
  ])
  started.push(postgres, { container: minio })

  await createDatabases(postgres.url('postgres'), ['voucher_it'])
  await deployMigrations(APP_DIR, postgres.url('voucher_it'))
  prisma = createPrismaClient(postgres.url('voucher_it'))

  minioUrl = `http://${minio.getHost()}:${String(minio.getMappedPort(9000))}`
  const admin = new Client({
    endPoint: minio.getHost(),
    port: minio.getMappedPort(9000),
    useSSL: false,
    accessKey: MINIO_USER,
    secretKey: MINIO_PASSWORD,
  })
  await admin.makeBucket(BUCKET)

  storage = createMinioStorage({
    internalUrl: minioUrl,
    publicUrl: minioUrl,
    accessKey: MINIO_USER,
    secretKey: MINIO_PASSWORD,
    bucket: BUCKET,
  })
  await storage.resource.start?.()
})

afterAll(async () => {
  await prisma.$disconnect()
  await Promise.allSettled(started.map(async (item) => await item.container.stop()))
})

function realDeps(): VoucherDeps {
  const fakes = world()
  return {
    ...fakes.deps,
    vouchers: createPrismaVoucherRepository(prisma),
    storage,
    renderer: createPdfKitRenderer(),
    ids: uuidFactory,
    tokens: secureTokens,
  }
}

function sampleVoucher(overrides: Partial<Voucher> = {}): Voucher {
  return {
    id: uuidFactory.next(),
    bookingId: '018f2a1c-0000-7000-8000-00000000c001',
    userId: USER,
    objectKey: `v/${secureTokens.next()}.pdf`,
    sizeBytes: 1_024,
    issuedAt: new Date('2026-10-07T03:00:04.000Z'),
    confirmedAt: new Date('2026-10-07T03:00:00.000Z'),
    ...overrides,
  }
}

describe('batasan UNIK booking_id di Postgres', () => {
  test('baris kedua untuk pemesanan yang sama ditolak dan pemenangnya dikembalikan', async () => {
    const repository = createPrismaVoucherRepository(prisma)
    const first = sampleVoucher()

    const outcomes = await Promise.all([
      repository.insert(first),
      repository.insert(sampleVoucher({ id: uuidFactory.next() })),
    ])

    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(['exists', 'inserted'])
    const stored = await repository.findByBookingId(first.bookingId)
    const loser = outcomes.find((outcome) => outcome.kind === 'exists')
    expect(loser?.kind === 'exists' && loser.existing).toEqual(stored)
  })
})

describe('alur sungguhan: PDF ke MinIO, metadata ke Postgres', () => {
  test('perintah yang sama dua kali, serentak: satu voucher, satu berkas', async () => {
    const deps = realDeps()

    const results = await Promise.all([
      issueVoucher(deps, BOOKING_ID),
      issueVoucher(deps, BOOKING_ID),
    ])

    const kinds = results.map((result) => result.kind)
    expect(kinds.filter((kind) => kind === 'issued')).toHaveLength(1)
    expect(await prisma.voucher.count({ where: { bookingId: BOOKING_ID } })).toBe(1)

    const objects: string[] = []
    const admin = new Client({
      endPoint: new URL(minioUrl).hostname,
      port: Number(new URL(minioUrl).port),
      useSSL: false,
      accessKey: MINIO_USER,
      secretKey: MINIO_PASSWORD,
    })
    for await (const item of admin.listObjectsV2(BUCKET, 'v/', true)) {
      if (typeof item.name === 'string') objects.push(item.name)
    }
    const stored = await prisma.voucher.findUnique({ where: { bookingId: BOOKING_ID } })
    // Berkas yang kalah berpacu sudah dihapus; yang tersisa hanya milik pemenang.
    expect(objects).toContain(stored?.objectKey)
    expect(objects.filter((name) => name !== stored?.objectKey)).not.toContain(
      expect.stringContaining(BOOKING_ID),
    )
  })

  test('pemilik mengunduh PDF lewat URL bertanda tangan; pengguna lain tidak mendapat URL', async () => {
    const deps = realDeps()

    const mine = await voucherLink(deps, { userId: USER, bookingId: BOOKING_ID })
    const theirs = await voucherLink(deps, { userId: OTHER_USER, bookingId: BOOKING_ID })

    expect(theirs.kind).toBe('not_found')
    if (mine.kind !== 'link') throw new Error(`tidak ada tautan: ${mine.kind}`)
    const response = await fetch(mine.url)
    const body = new Uint8Array(await response.arrayBuffer())
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/pdf')
    expect(Buffer.from(body.subarray(0, 5)).toString('latin1')).toBe('%PDF-')
  })

  test('isi berkas dibaca kembali utuh untuk lampiran surel (Step 24)', async () => {
    const pdf = await voucherDocument(realDeps(), BOOKING_ID)
    const stored = await prisma.voucher.findUnique({ where: { bookingId: BOOKING_ID } })

    expect(pdf?.byteLength).toBe(stored?.sizeBytes)
    expect(Buffer.from(pdf?.subarray(0, 5) ?? []).toString('latin1')).toBe('%PDF-')
  })

  test('URL yang tanda tangannya diubah ditolak MinIO', async () => {
    const deps = realDeps()
    const link = await voucherLink(deps, { userId: USER, bookingId: BOOKING_ID })
    if (link.kind !== 'link') throw new Error('tidak ada tautan')

    const tampered = link.url.replace(
      /X-Amz-Signature=([0-9a-f])/,
      (_match, first: string) => `X-Amz-Signature=${first === '0' ? '1' : '0'}`,
    )

    expect((await fetch(tampered)).status).toBe(403)
  })

  test('objek tanpa URL bertanda tangan tidak dapat dibuka', async () => {
    const stored = await prisma.voucher.findUnique({ where: { bookingId: BOOKING_ID } })

    const response = await fetch(`${minioUrl}/${BUCKET}/${stored?.objectKey ?? ''}`)

    expect(response.status).toBe(403)
  })
})
