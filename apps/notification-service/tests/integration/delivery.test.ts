import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDatabases, deployMigrations, startPostgres, type Started } from '@tbe/testing-infra'
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { deliverDue } from '../../src/application/deliver.js'
import type { NotificationDeps } from '../../src/application/ports.js'
import { createPrismaClient } from '../../src/infrastructure/prisma-client.js'
import { createPrismaNotificationRepository } from '../../src/infrastructure/prisma-notification-repository.js'
import { createSmtpSender, createSmtpTransport } from '../../src/infrastructure/smtp-sender.js'
import { uuidSource } from '../../src/infrastructure/system.js'
import { handleNotificationEvent } from '../../src/messaging/booking-events.js'
import type { BookingSnapshot } from '../../src/domain/booking-snapshot.js'
import { VOUCHER_NOT_READY } from '../../src/domain/delivery.js'
import type { ClaimedNotification } from '../../src/domain/notification.js'
import { BOOKING_ID, confirmationRequest, snapshot, world } from '../../src/testing/fakes.js'

/**
 * Postgres dan Mailpit SUNGGUHAN lewat Testcontainers (CONVENTIONS.md
 * bagian 10). booking-service dan voucher-service tetap palsuan — jawaban
 * HTTP mereka sudah diuji di http-directories.test.ts.
 *
 * Yang dibuktikan di sini tidak dapat dibuktikan palsuan mana pun: batasan
 * UNIK dedupe_key di migrasi, FOR UPDATE SKIP LOCKED pada dua penghantar
 * yang berpacu, dan surel yang benar-benar tiba di server SMTP — dengan versi
 * teks, versi HTML, dan voucher terlampir.
 */

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const MAILPIT_IMAGE = 'axllent/mailpit:latest'
const FROM = 'Lintang <bantuan@lintang.test>'
/** PDF terkecil yang sah; isinya tidak penting, yang diuji adalah lampirannya. */
const PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')

const started: Started[] = []
let prisma: ReturnType<typeof createPrismaClient> | undefined
let smtp: ReturnType<typeof createSmtpTransport> | undefined
let mailpitApi = ''

beforeAll(async () => {
  const [postgres, mailpit] = await Promise.all([startPostgres(), startMailpit()])
  started.push(postgres, { container: mailpit })

  await createDatabases(postgres.url('postgres'), ['notification_it'])
  await deployMigrations(APP_DIR, postgres.url('notification_it'))
  prisma = createPrismaClient(postgres.url('notification_it'))

  mailpitApi = `http://${mailpit.getHost()}:${String(mailpit.getMappedPort(8025))}/api/v1`
  smtp = createSmtpTransport({
    host: mailpit.getHost(),
    port: mailpit.getMappedPort(1025),
    secure: false,
    user: undefined,
    password: undefined,
    timeoutMs: 5_000,
  })
})

afterAll(async () => {
  await smtp?.resource.stop()
  await prisma?.$disconnect()
  await Promise.allSettled(started.map(async (item) => await item.container.stop()))
})

beforeEach(async () => {
  await db().notification.deleteMany()
  await fetch(`${mailpitApi}/messages`, { method: 'DELETE' })
  await setChaos(null)
})

async function claim(deps: NotificationDeps, now: Date): Promise<ClaimedNotification> {
  const claimed = await deps.notifications.claimNext(now, 60_000)
  if (claimed === undefined) throw new Error('tidak ada yang terambil')
  return claimed
}

function db(): NonNullable<typeof prisma> {
  if (prisma === undefined) throw new Error('Postgres belum siap')
  return prisma
}

function mail(): NonNullable<typeof smtp> {
  if (smtp === undefined) throw new Error('Mailpit belum siap')
  return smtp
}

async function startMailpit(): Promise<StartedTestContainer> {
  return await new GenericContainer(MAILPIT_IMAGE)
    .withEnvironment({ MP_ENABLE_CHAOS: 'true' })
    .withExposedPorts(1025, 8025)
    .withWaitStrategy(Wait.forHttp('/readyz', 8025))
    .start()
}

/** Fitur chaos Mailpit: menolak penerima dengan kode SMTP tertentu. */
async function setChaos(recipientErrorCode: number | null): Promise<void> {
  const response = await fetch(`${mailpitApi}/chaos`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      Recipient: {
        ErrorCode: recipientErrorCode ?? 451,
        Probability: recipientErrorCode === null ? 0 : 100,
      },
    }),
  })
  expect(response.ok).toBe(true)
}

interface MailpitSummary {
  readonly ID: string
  readonly Subject: string
  readonly To: readonly { readonly Address: string }[]
}

async function inbox(): Promise<readonly MailpitSummary[]> {
  const response = await fetch(`${mailpitApi}/messages`)
  const body = (await response.json()) as { messages: MailpitSummary[] } // jawaban API Mailpit, bentuknya diperiksa uji di bawah
  return body.messages
}

function realDeps(options: { snapshots?: readonly BookingSnapshot[] } = {}): NotificationDeps {
  const fakes = world(options)
  fakes.vouchers.documents.set(BOOKING_ID, PDF)
  return {
    ...fakes.deps,
    clock: { now: () => new Date() },
    notifications: createPrismaNotificationRepository(db(), uuidSource),
    sender: createSmtpSender(mail().transport, FROM),
  }
}

describe('batasan UNIK dedupe_key di Postgres', () => {
  test('dua permintaan serentak dengan kunci yang sama: satu baris', async () => {
    const deps = realDeps()

    const outcomes = await Promise.all(
      Array.from(
        { length: 5 },
        async () => await deps.notifications.request(confirmationRequest(), new Date()),
      ),
    )

    expect(outcomes.filter((outcome) => outcome.kind === 'created')).toHaveLength(1)
    expect(await db().notification.count()).toBe(1)
  })

  test('peristiwa yang sama dua kali menghasilkan satu surel di server SMTP', async () => {
    const deps = realDeps({ snapshots: [snapshot({ status: 'FAILED', supplierRef: null })] })
    const handle = handleNotificationEvent(deps, {
      maxEventAgeMs: 3_600_000,
      wake: () => undefined,
    })
    const message = {
      eventId: '018f2a1c-0000-7000-8000-0000000e0042',
      eventType: 'booking.failed' as const,
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      correlationId: 'corr-it',
      payload: {
        bookingId: BOOKING_ID,
        stage: 'supplier_confirm' as const,
        reason: 'habis',
        requiresManualReview: false,
      },
    }

    await handle(message)
    await handle(message)
    await deliverDue(deps)
    await deliverDue(deps)

    const messages = await inbox()
    expect(messages).toHaveLength(1)
    expect(messages[0]?.Subject).toContain('dikembalikan otomatis')
  })

  test('duplikat membangunkan surel yang menunggu voucher, tetapi tidak menyentuh yang sedang disewa', async () => {
    const deps = realDeps()
    const now = new Date()
    await deps.notifications.request(confirmationRequest(), now)
    const claimed = await claim(deps, now)
    const later = new Date(now.getTime() + 30_000)
    await deps.notifications.settle(
      claimed,
      { kind: 'retry', attempts: 1, nextAttemptAt: later, reason: VOUCHER_NOT_READY },
      now,
    )

    await deps.notifications.request(confirmationRequest(), now)

    const nudged = await db().notification.findUniqueOrThrow({ where: { id: claimed.id } })
    expect(nudged.nextAttemptAt.getTime()).toBe(now.getTime())
    expect(nudged.attempts).toBe(1)

    await claim(deps, now)
    await deps.notifications.request(confirmationRequest(), new Date(now.getTime() - 1_000))
    const leased = await db().notification.findUniqueOrThrow({ where: { id: claimed.id } })
    expect(leased.status).toBe('SENDING')
    expect(leased.nextAttemptAt.getTime()).toBe(now.getTime())
  })

  test('duplikat TIDAK melompati jenjang tunda kegagalan lain (SMTP mati)', async () => {
    const deps = realDeps()
    const now = new Date()
    await deps.notifications.request(confirmationRequest(), now)
    const claimed = await claim(deps, now)
    const later = new Date(now.getTime() + 30_000)
    await deps.notifications.settle(
      claimed,
      { kind: 'retry', attempts: 1, nextAttemptAt: later, reason: 'smtp_421' },
      now,
    )

    await deps.notifications.request(confirmationRequest(), now)

    const row = await db().notification.findUniqueOrThrow({ where: { id: claimed.id } })
    expect(row.nextAttemptAt.getTime()).toBe(later.getTime())
  })

  test('voucher yang terlambat melewati seluruh jenjang: voucher.issued menghidupkan surel yang DEAD', async () => {
    const deps = realDeps()
    const now = new Date()
    await deps.notifications.request(confirmationRequest(), now)
    const claimed = await claim(deps, now)
    await deps.notifications.settle(
      claimed,
      { kind: 'dead', attempts: 6, reason: VOUCHER_NOT_READY },
      now,
    )

    await deps.notifications.request(confirmationRequest(), now)

    const row = await db().notification.findUniqueOrThrow({ where: { id: claimed.id } })
    expect(row).toMatchObject({ status: 'PENDING', attempts: 0 })
  })
})

describe('penghantar terhadap Postgres sungguhan', () => {
  test('dua penghantar yang berpacu mengambil baris berbeda (SKIP LOCKED)', async () => {
    const deps = realDeps()
    const now = new Date()
    for (let index = 0; index < 10; index += 1) {
      await deps.notifications.request(
        confirmationRequest({ dedupeKey: `command:it-${String(index)}`, source: 'command' }),
        now,
      )
    }

    const claims = await Promise.all(
      Array.from({ length: 12 }, async () => await deps.notifications.claimNext(now, 60_000)),
    )

    const ids = claims.flatMap((row) => (row === undefined ? [] : [row.id]))
    expect(ids).toHaveLength(10)
    expect(new Set(ids).size).toBe(10)
  })

  test('sewa yang habis diambil lagi dan dihitung sebagai percobaan; pemegang lama tidak dapat mencatat hasil', async () => {
    const deps = realDeps()
    const now = new Date()
    await deps.notifications.request(confirmationRequest(), now)
    const first = await claim(deps, now)

    expect(await deps.notifications.claimNext(new Date(now.getTime() + 500), 1_000)).toBeUndefined()
    const second = await claim(deps, new Date(now.getTime() + 60_001))
    expect(second.attempts).toBe(1)

    const sent = { kind: 'sent', at: now, recipientKey: 'k', userId: snapshot().userId } as const
    expect(await deps.notifications.settle(first, sent, now)).toBe(false)
    expect(await deps.notifications.settle(second, sent, now)).toBe(true)
  })

  test('isi baris yang tidak dapat diurai tidak menghentikan penghantaran', async () => {
    const deps = realDeps()
    const now = new Date()
    await deps.notifications.request(confirmationRequest(), new Date(now.getTime() - 1_000))
    await deps.notifications.request(
      confirmationRequest({ dedupeKey: 'command:sehat', source: 'command' }),
      now,
    )
    await db().notification.updateMany({
      where: { dedupeKey: confirmationRequest().dedupeKey },
      data: { context: { type: 'jenis_dari_masa_depan' } },
    })

    await deliverDue(deps)

    const rows = await db().notification.findMany({ orderBy: { createdAt: 'asc' } })
    expect(rows.map((row) => [row.status, row.lastError])).toEqual([
      ['DEAD', 'invalid_context'],
      ['SENT', null],
    ])
  })

  test('surel konfirmasi tiba di Mailpit dengan versi teks, versi HTML, dan voucher terlampir', async () => {
    const deps = realDeps()
    await deps.notifications.request(confirmationRequest(), new Date())

    await deliverDue(deps)

    const [summary] = await inbox()
    expect(summary?.To.map((to) => to.Address)).toEqual(['sari@example.com'])
    const response = await fetch(`${mailpitApi}/message/${summary?.ID ?? ''}`)
    const message = (await response.json()) as {
      Subject: string
      Text: string
      HTML: string
      Attachments: { FileName: string; ContentType: string; Size: number }[]
    } // jawaban API Mailpit; setiap bidang diperiksa di bawah
    expect(message.Subject).toBe('Pemesananmu terkonfirmasi — kode SKY-BK-7F3A21')
    expect(message.Text).toContain('Kode pemesananmu di penyedia adalah SKY-BK-7F3A21')
    expect(message.Text).toContain('10 November 2026')
    expect(message.HTML).toContain('SKY-BK-7F3A21')
    expect(message.Attachments).toEqual([
      expect.objectContaining({
        FileName: 'e-voucher.pdf',
        ContentType: 'application/pdf',
        Size: PDF.byteLength,
      }),
    ])
    const row = await db().notification.findFirstOrThrow()
    expect(row).toMatchObject({ status: 'SENT', userId: snapshot().userId, lastError: null })
  })

  test('alamat yang ditolak server (550) gagal permanen dan tidak dicoba ulang', async () => {
    await setChaos(550)
    const deps = realDeps()
    await deps.notifications.request(confirmationRequest(), new Date())

    await deliverDue(deps)

    const row = await db().notification.findFirstOrThrow()
    expect(row).toMatchObject({ status: 'FAILED', lastError: 'smtp_550', attempts: 0 })
    expect(JSON.stringify(row)).not.toContain('sari@example.com')
  })

  test('penolakan sementara (451) dijadwalkan ulang', async () => {
    await setChaos(451)
    const deps = realDeps()
    await deps.notifications.request(confirmationRequest(), new Date())

    await deliverDue(deps)

    const row = await db().notification.findFirstOrThrow()
    expect(row).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      lastError: 'smtp_451',
      leaseUntil: null,
    })
  })

  test('batas laju menghitung surel TERKIRIM ke penerima yang sama', async () => {
    const deps = realDeps()
    await deps.notifications.request(confirmationRequest(), new Date())
    await deliverDue(deps)
    const row = await db().notification.findFirstOrThrow()

    const count = await deps.notifications.sentToRecipientSince(
      row.recipientKey ?? '',
      new Date(Date.now() - 60_000),
    )

    expect(count).toBe(1)
  })
})
