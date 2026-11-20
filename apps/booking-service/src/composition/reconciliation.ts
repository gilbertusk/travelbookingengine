import { randomUUID } from 'node:crypto'
import {
  createCommandConsumer,
  mainQueue,
  type CommandSender,
  type RabbitConnection,
} from '@tbe/messaging'
import type { Logger, ManagedResource } from '@tbe/shared-kernel'
import { reconcile, type ReconcileDeps } from '../application/reconcile.js'
import { createScheduler, type ReconciliationRequests } from '../application/reconcile-schedule.js'
import type { ReconciliationOps } from '../http/reconciliation-routes.js'
import { periodicResource } from './periodic.js'

/**
 * Rekonsiliasi dirangkai (Step 28): pengirim perintah, penjadwal, consumer,
 * dan pemicu dari panel operator — keempatnya lewat `reconciliation.run`.
 */

export function reconciliationRequests(sender: CommandSender): ReconciliationRequests {
  return {
    async request(run) {
      await sender.send(
        'reconciliation.run',
        { date: run.day, ...(run.supplier === undefined ? {} : { supplier: run.supplier }) },
        { eventId: run.id },
      )
    },
  }
}

/** Detak setiap menit; perintah hanya saat slot berganti (lihat createScheduler). */
const SCHEDULER_TICK_MS = 60_000

export function reconciliationScheduler(options: {
  readonly requests: ReconciliationRequests
  readonly intervalMs: number
  readonly now: () => Date
  readonly logger: Logger
}): ManagedResource {
  const scheduler = createScheduler(options)

  return periodicResource({
    name: 'reconciliation-scheduler',
    intervalMs: SCHEDULER_TICK_MS,
    logger: options.logger,
    failure: 'perintah rekonsiliasi terjadwal gagal dikirim; dicoba lagi pada detak berikutnya',
    tick: async () => {
      const slot = await scheduler.tick()
      if (slot !== undefined) options.logger.info(slot, 'putaran rekonsiliasi diminta')
      return false
    },
  })
}

/**
 * Consumer `reconciliation.run`. Prefetch satu: satu putaran per instance
 * pada satu waktu — putaran memanggil supplier berurutan dengan sengaja, dan
 * dua putaran serentak di satu instance hanya menggandakan bebannya.
 */
export function reconciliationConsumer(
  rabbit: RabbitConnection,
  deps: ReconcileDeps,
): ManagedResource {
  return {
    name: 'reconciliation-consumer',
    start: async () => {
      rabbit.consume(
        mainQueue('reconciliation.run'),
        1,
        createCommandConsumer({
          command: 'reconciliation.run',
          publisher: rabbit.publisher,
          logger: deps.logger,
          handle: async (payload, message) => {
            const outcome = await reconcile(deps, {
              id: message.eventId,
              day: payload.date,
              supplier: payload.supplier,
            })
            if (outcome.kind === 'already_finished') {
              deps.logger.debug({ runId: message.eventId }, 'putaran rekonsiliasi sudah selesai')
            }
          },
        }),
      )
      await Promise.resolve()
    },
    stop: async () => {
      await Promise.resolve()
    },
  }
}

/** Pemicu dari panel operator: putaran baru dengan pengenal acak, hari ini (UTC). */
export function operatorTrigger(
  requests: ReconciliationRequests,
  now: () => Date,
): ReconciliationOps['request'] {
  return async (supplier) => {
    const id = randomUUID()
    await requests.request({ id, day: now().toISOString().slice(0, 10), supplier })
    return id
  }
}
