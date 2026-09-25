import type {
  ClaimResult,
  InsertOutcome,
  WebhookClaim,
  WebhookLedger,
  WebhookOutcome,
} from '../application/ports.js'
import type { Payment, Refund, SettledPayment } from '../domain/payment.js'
import type { PaymentRepository } from '../application/ports.js'

/**
 * Palsuan penyimpanan: buku besar webhook dan repository pembayaran.
 *
 * Dipisahkan dari fakes.ts karena keduanya bersama-sama membawa SATU gagasan
 * yang layak dibaca sendiri: **apa yang ditiru palsuan ini adalah batasan UNIK,
 * dan posisi `await` di dalamnya adalah seluruh pokoknya.**
 *
 * Untuk setiap palsuan yang menirunya, ada palsuan TANDINGAN yang justru memakai
 * pola "periksa dulu baru tulis". Keduanya dipakai uji untuk membuktikan bahwa
 * uji balapan tidak hampa: uji yang sama harus GAGAL pada palsuan tandingan.
 * Tanpa itu, "sepuluh webhook serentak menghasilkan satu efek" bisa lulus hanya
 * karena palsuannya tidak pernah benar-benar menghadapi balapan.
 *
 * Yang tetap TIDAK dibuktikan di sini: bahwa Postgres sungguhan menegakkannya.
 * Itu pekerjaan uji integrasi Step 20, dan dicatat apa adanya di README.
 */

interface LedgerRow {
  readonly payload: unknown
  outcome: WebhookOutcome | undefined
  paymentId: string | undefined
}

export interface RecordingLedger extends WebhookLedger {
  readonly rows: Map<string, LedgerRow>
  readonly claims: string[]
}

/**
 * Buku besar yang meniru batasan UNIK.
 *
 * **Posisi `await` adalah seluruh pokoknya.** Pemeriksaan dan penulisan terjadi
 * dalam satu langkah sinkron, tanpa satu pun titik tunggu di antaranya, sehingga
 * sepuluh pemanggilan serentak hanya menghasilkan satu pemenang — persis seperti
 * `INSERT` kedua yang ditolak Postgres. Memindahkan `await Promise.resolve()` ke
 * atas `rows.set` mengubah palsuan ini menjadi [racyWebhookLedger].
 */
export function memoryWebhookLedger(): RecordingLedger {
  const rows = new Map<string, LedgerRow>()
  const claims: string[] = []

  return {
    rows,
    claims,

    async claim(claim: WebhookClaim): Promise<ClaimResult> {
      claims.push(claim.providerEventId)
      const existing = rows.get(claim.providerEventId)

      if (existing === undefined) {
        rows.set(claim.providerEventId, {
          payload: claim.payload,
          outcome: undefined,
          paymentId: undefined,
        })

        // Titik tunggu HANYA setelah penulisan.
        await Promise.resolve()
        return { kind: 'claimed' }
      }

      await Promise.resolve()

      return existing.outcome === undefined
        ? { kind: 'in_progress' }
        : { kind: 'already_processed', outcome: existing.outcome }
    },

    async complete(providerEventId, outcome, paymentId): Promise<void> {
      const row = rows.get(providerEventId)

      if (row !== undefined) {
        row.outcome = outcome
        row.paymentId = paymentId
      }

      await Promise.resolve()
    },
  }
}

/**
 * Palsuan TANDINGAN: "periksa dulu baru tulis".
 *
 * Sengaja salah, dan dipakai untuk membuktikan uji balapan bermakna. Titik
 * tunggu berada DI ANTARA pemeriksaan dan penulisan, sehingga sepuluh
 * pemanggilan serentak semuanya melihat "belum ada" dan semuanya mengklaim.
 *
 * Inilah yang terjadi pada kode sungguhan yang memakai `findUnique` lalu
 * `create` alih-alih mengandalkan batasan UNIK. Pada satu proses dengan trafik
 * rendah, ia terlihat bekerja sempurna.
 */
export function racyWebhookLedger(): RecordingLedger {
  const rows = new Map<string, LedgerRow>()
  const claims: string[] = []

  return {
    rows,
    claims,

    async claim(claim: WebhookClaim): Promise<ClaimResult> {
      claims.push(claim.providerEventId)
      const existing = rows.get(claim.providerEventId)

      // Titik tunggu di antara pemeriksaan dan penulisan — inilah celahnya.
      await Promise.resolve()

      if (existing === undefined) {
        rows.set(claim.providerEventId, {
          payload: claim.payload,
          outcome: undefined,
          paymentId: undefined,
        })

        return { kind: 'claimed' }
      }

      return existing.outcome === undefined
        ? { kind: 'in_progress' }
        : { kind: 'already_processed', outcome: existing.outcome }
    },

    async complete(providerEventId, outcome, paymentId): Promise<void> {
      const row = rows.get(providerEventId)

      if (row !== undefined) {
        row.outcome = outcome
        row.paymentId = paymentId
      }

      await Promise.resolve()
    },
  }
}

export interface RecordingRepository extends PaymentRepository {
  readonly rows: Map<string, Payment>
  /** Urutan penulisan, dipakai membuktikan peristiwa terbit SETELAH penyimpanan. */
  readonly writes: string[]
}

interface RepositoryOptions {
  readonly effects?: string[] | undefined
  /** true membuat penyisipan memakai pola "periksa dulu baru tulis". */
  readonly racy?: boolean | undefined
}

interface RepositoryState {
  readonly rows: Map<string, Payment>
  readonly racy: boolean
  note(what: string): void
}

function buildRepository(options: RepositoryOptions = {}): RecordingRepository {
  const rows = new Map<string, Payment>()
  const writes: string[] = []
  const effects = options.effects ?? []

  const state: RepositoryState = {
    rows,
    racy: options.racy ?? false,
    note(what) {
      writes.push(what)
      effects.push(what)
    },
  }

  return {
    rows,
    writes,
    findById: async (id) => await read(rows, id),
    insert: async (payment) => await insertPayment(state, payment),
    update: async (payment) => {
      rows.set(payment.id, payment)
      state.note(`update:${payment.id}:${payment.status}`)
      await Promise.resolve()
    },
    insertRefund: async (payment, refund) => await insertRefund(state, payment, refund),
    updateRefund: async (payment, refund) => {
      rows.set(payment.id, payment)
      state.note(`refund-update:${refund.requestId}:${refund.status}`)
      await Promise.resolve()
    },
  }
}

async function read(rows: Map<string, Payment>, id: string): Promise<Payment | undefined> {
  await Promise.resolve()

  return rows.get(id)
}

/**
 * Penyisipan pembayaran, dijaga batasan UNIK pada `idempotencyKey`.
 *
 * Pada mode biasa tidak ada satu pun titik tunggu antara pemeriksaan dan
 * penulisan; pada mode `racy` titik tunggu itu ADA, dan di situlah dua permintaan
 * serentak sama-sama lolos.
 */
async function insertPayment(
  state: RepositoryState,
  payment: Payment,
): Promise<InsertOutcome<Payment>> {
  const clash = [...state.rows.values()].find(
    (row) => row.idempotencyKey === payment.idempotencyKey,
  )

  if (state.racy) await Promise.resolve()

  if (clash !== undefined) {
    if (!state.racy) await Promise.resolve()

    return { kind: 'conflict', existing: clash }
  }

  state.rows.set(payment.id, payment)
  state.note(`insert:${payment.id}`)

  if (!state.racy) await Promise.resolve()

  return { kind: 'inserted' }
}

/** Penyisipan refund, dijaga batasan UNIK pada `requestId`. */
async function insertRefund(
  state: RepositoryState,
  payment: SettledPayment,
  refund: Refund,
): Promise<InsertOutcome<Refund>> {
  const existing = findRefund(state.rows, refund.requestId)

  if (state.racy) await Promise.resolve()

  if (existing !== undefined) {
    if (!state.racy) await Promise.resolve()

    return { kind: 'conflict', existing }
  }

  state.rows.set(payment.id, payment)
  state.note(`refund:${refund.requestId}`)

  if (!state.racy) await Promise.resolve()

  return { kind: 'inserted' }
}

function findRefund(rows: Map<string, Payment>, requestId: string): Refund | undefined {
  for (const row of rows.values()) {
    if (row.status === 'PENDING' || row.status === 'FAILED') continue

    const found = row.refunds.find((refund) => refund.requestId === requestId)
    if (found !== undefined) return found
  }

  return undefined
}

/** Repository yang meniru batasan UNIK: penyisipan kedua ditolak. */
export function memoryPaymentRepository(effects?: string[]): RecordingRepository {
  return buildRepository({ effects })
}

/** Palsuan tandingan: "periksa dulu baru tulis". Sengaja salah. */
export function racyPaymentRepository(effects?: string[]): RecordingRepository {
  return buildRepository({ effects, racy: true })
}
