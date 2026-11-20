import { randomUUID } from 'node:crypto'
import type {
  ReconciliationDb,
  ReconciliationFindingRow,
  ReconciliationRunRow,
} from '../infrastructure/booking-db.js'

/**
 * Palsuan port laporan rekonsiliasi (Step 28). Meniru tiga perilaku Prisma
 * yang diandalkan penyimpannya: `createMany` + `skipDuplicates` tidak menimpa
 * baris yang ada, `upsert` pada kunci unik (putaran, pemesanan), dan urutan
 * `startedAt` menurun.
 */
export interface MemoryReconciliationDb extends ReconciliationDb {
  readonly runs: Map<string, ReconciliationRunRow>
  readonly findings: ReconciliationFindingRow[]
}

export function memoryReconciliationDb(): MemoryReconciliationDb {
  const runs = new Map<string, ReconciliationRunRow>()
  const findings: ReconciliationFindingRow[] = []

  return {
    runs,
    findings,
    reconciliationRun: runTable(runs),
    reconciliationFinding: findingTable(findings),
  }
}

function runTable(runs: Map<string, ReconciliationRunRow>): ReconciliationDb['reconciliationRun'] {
  return {
    createMany: async ({ data }) => {
      await Promise.resolve()
      let count = 0
      for (const row of data) {
        if (runs.has(row.id)) continue
        runs.set(row.id, {
          ...row,
          checked: 0,
          matched: 0,
          mismatched: 0,
          unverified: 0,
          flagged: 0,
        })
        count += 1
      }
      return { count }
    },
    findUnique: async ({ where }) => {
      await Promise.resolve()
      return structuredClone(runs.get(where.id)) ?? null
    },
    update: async ({ where, data }) => {
      await Promise.resolve()
      const row = runs.get(where.id)
      if (row === undefined) throw new Error(`putaran ${where.id} tidak ada`)
      runs.set(where.id, { ...row, ...data })
    },
    findMany: async ({ take }) => {
      await Promise.resolve()
      return structuredClone(
        [...runs.values()]
          .toSorted((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
          .slice(0, take),
      )
    },
  }
}

function findingTable(
  findings: ReconciliationFindingRow[],
): ReconciliationDb['reconciliationFinding'] {
  return {
    upsert: async ({ where, create, update }) => {
      await Promise.resolve()
      const key = where.runId_bookingId
      const index = findings.findIndex(
        (row) => row.runId === key.runId && row.bookingId === key.bookingId,
      )
      const existing = findings[index]
      if (existing === undefined) findings.push({ id: randomUUID(), ...create })
      else findings.splice(index, 1, { ...existing, ...update })
    },
    findMany: async ({ where, take }) => {
      await Promise.resolve()
      return structuredClone(
        findings
          .filter((row) => where.runId.in.includes(row.runId))
          .toSorted((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime())
          .slice(0, take),
      )
    },
  }
}
