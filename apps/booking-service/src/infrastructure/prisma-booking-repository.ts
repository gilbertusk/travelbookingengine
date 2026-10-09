import type {
  BookingRepository,
  CreateOutcome,
  SaveOutcome,
  UserBookingsQuery,
} from '../application/ports.js'
import type { Booking, DraftBooking } from '../domain/booking.js'
import {
  ENDED_WITHOUT_STAY_STATUSES,
  IN_PROGRESS_STATUSES,
  type BookingGroup,
} from '../domain/booking-groups.js'
import type { BookingChange } from '../domain/events.js'
import type { IdempotencyKey } from '../domain/idempotency-key.js'
import {
  isUniqueViolation,
  type BookingClause,
  type BookingDb,
  type BookingQuery,
} from './booking-db.js'
import { fromRow, toDateColumn, toEventRow, toRow } from './booking-rows.js'
import { commitTransition, writeEventOutbox } from './unit-of-work.js'

/**
 * Repository pemesanan di atas Prisma.
 *
 * **Setiap penulisan adalah satu `$transaction` yang memuat baris bookings DAN
 * baris booking_events-nya.** Bukan dua penulisan berurutan, dan bukan dua
 * transaksi. Dua penulisan dapat berhenti di tengah — proses mati, koneksi
 * putus, batasan dilanggar pada tulisan kedua — dan yang tertinggal adalah
 * keadaan tanpa jejak audit (melanggar NFR-10) atau jejak tentang keadaan yang
 * tidak pernah tersimpan.
 *
 * Urutan di dalam transaksi pun dipilih: baris pemesanan dulu, peristiwa
 * sesudahnya. Kunci asing booking_events → bookings menuntutnya pada
 * pembuatan, dan pada transisi, pemeriksaan versi harus menang lebih dulu
 * sebelum ada yang ditulis ke jejak.
 *
 * Step 19: transaksi yang sama juga menulis padanan Kafka peristiwanya ke
 * OUTBOX — `booking.created` pada pembuatan, dan seterusnya. Menerbitkannya
 * langsung ke Kafka dari sini ditolak: penerbitan di dalam transaksi terjadi
 * walau transaksinya lalu batal, dan penerbitan sesudahnya hilang bila proses
 * mati di antara commit dan kirim. payment-service tidak dapat menagih
 * pemesanan yang `booking.created`-nya tidak pernah tiba.
 */
export function createPrismaBookingRepository(db: BookingDb): BookingRepository {
  async function findById(id: string): Promise<Booking | undefined> {
    const row = await db.booking.findUnique({ where: { id } })

    return row === null ? undefined : fromRow(row)
  }

  async function findByIdempotencyKey(
    userId: string,
    key: IdempotencyKey,
  ): Promise<Booking | undefined> {
    const row = await db.booking.findFirst({ where: { userId, idempotencyKey: key } })

    return row === null ? undefined : fromRow(row)
  }

  /**
   * Pembuatan, dijaga batasan UNIK `(user_id, idempotency_key)`.
   *
   * TIDAK ada pemeriksaan "sudah ada?" sebelum menyisipkan. Dua permintaan
   * serentak dengan kunci yang sama akan sama-sama menjawab "belum" dan
   * sama-sama menyisipkan; hanya basis data yang melihat keduanya sekaligus.
   * Pemeriksaan terjadi SESUDAH penolakan, di luar transaksi yang sudah
   * dibatalkan, untuk mengambil pemenangnya.
   */
  async function create(change: BookingChange<DraftBooking>): Promise<CreateOutcome> {
    const { booking, event } = change

    try {
      await db.$transaction(async (tx) => {
        await tx.booking.create({ data: toRow(booking) })
        await tx.bookingEvent.create({ data: toEventRow(event) })
        await writeEventOutbox(tx, change, undefined)
      })

      return { kind: 'created' }
    } catch (error) {
      if (!isUniqueViolation(error)) throw error

      const existing = await findByIdempotencyKey(booking.userId, booking.idempotencyKey)

      // Pelanggaran UNIK yang bukan kunci idempotensi — id pemesanan yang
      // bertabrakan — bukan duplikat permintaan. Menjawabnya "duplicate"
      // tanpa pemesanan yang cocok akan menyembunyikan cacat pembangkit id.
      if (existing === undefined) throw error

      return { kind: 'duplicate', existing }
    }
  }

  /**
   * Transisi, dijaga kunci versi — lihat unit-of-work.ts.
   *
   * `updateMany` dengan `version` di klausa WHERE, bukan `update`: Prisma
   * `update` melempar bila baris tidak ditemukan, dan "tidak ditemukan karena
   * versinya sudah berubah" adalah jawaban yang sah, bukan galat. Pada Postgres
   * dengan READ COMMITTED, penulis kedua menunggu kunci baris penulis pertama,
   * lalu mengevaluasi ulang WHERE terhadap versi yang sudah naik — dan
   * mendapat nol baris.
   */
  async function save(change: BookingChange): Promise<SaveOutcome> {
    const outcome = await commitTransition(db, change)
    if (outcome === 'saved') return { kind: 'saved' }

    return { kind: 'stale', current: await findById(change.booking.id) }
  }

  return {
    findById,
    findByIdempotencyKey,
    create,
    save,
    findExpiredHolds: async (now, limit) => await expiredHolds(db, now, limit),
    findOverdueCancellations: async (now, limit) => await overdueCancellations(db, now, limit),
    findByUser: async (query) => await byUser(db, query),
  }
}

/**
 * Kueri setiap kelompok daftar pemesanan (Step 26). Pernyataan yang sama
 * dengan `groupOf` di domain, sebagai klausa — uji di list-bookings.test.ts
 * memeriksa keduanya sepakat untuk setiap keadaan.
 */
const GROUP_QUERIES: Readonly<
  Record<BookingGroup, (today: Date) => Pick<BookingQuery, 'orderBy'> & { OR: BookingClause[] }>
> = {
  upcoming: (today) => ({
    OR: [
      { status: { in: IN_PROGRESS_STATUSES } },
      { status: { in: ['CONFIRMED'] }, checkOut: { gte: today } },
    ],
    orderBy: [{ checkIn: 'asc' }, { id: 'asc' }],
  }),
  past: (today) => ({
    OR: [{ status: { in: ['CONFIRMED'] }, checkOut: { lt: today } }],
    orderBy: [{ checkIn: 'desc' }, { id: 'asc' }],
  }),
  cancelled: () => ({
    OR: [{ status: { in: ENDED_WITHOUT_STAY_STATUSES } }],
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
  }),
}

async function byUser(db: BookingDb, query: UserBookingsQuery): Promise<readonly Booking[]> {
  const { OR, orderBy } = GROUP_QUERIES[query.group](toDateColumn(query.today))
  const rows = await db.booking.findMany({
    where: { userId: query.userId, OR },
    orderBy,
    skip: query.offset,
    take: query.limit,
  })

  return rows.map(fromRow)
}

/**
 * Pembatalan yang batas menunggu jawabannya sudah lewat (Step 25), yang paling
 * lama lebih dulu. Dilayani indeks `(status, cancel_deadline_at)`.
 */
async function overdueCancellations(
  db: BookingDb,
  now: Date,
  limit: number,
): Promise<readonly Booking[]> {
  const rows = await db.booking.findMany({
    where: { status: 'CANCELLING', cancelDeadlineAt: { lte: now } },
    orderBy: { cancelDeadlineAt: 'asc' },
    take: limit,
  })

  return rows.map(fromRow)
}

/**
 * Pemesanan yang hold-nya sudah lewat. Dilayani indeks `(status, held_until)`;
 * yang paling lama lebih dulu, supaya penyapu yang tertinggal jauh mengejar
 * dari ujung yang paling merugikan: inventaris yang tertahan paling lama.
 *
 * `lte`, bukan `lt`: sama dengan aturan domain, yang menyatakan hold
 * kedaluwarsa TEPAT pada batas waktunya. Versi pertama memakai `lt`, dan
 * uji menemukan dua jalur pelepasan dengan dua definisi "kedaluwarsa" —
 * jalur keyspace melepas di batas waktu, penyapu tidak.
 */
async function expiredHolds(db: BookingDb, now: Date, limit: number): Promise<readonly Booking[]> {
  const rows = await db.booking.findMany({
    where: { status: 'HELD', heldUntil: { lte: now } },
    orderBy: { heldUntil: 'asc' },
    take: limit,
  })

  return rows.map(fromRow)
}
