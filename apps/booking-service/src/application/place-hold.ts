import type { Booking } from '../domain/booking.js'
import type { BookingError } from '../domain/errors.js'
import { effectiveHoldUntil } from '../domain/hold-window.js'
import { isSameAmount } from '../domain/price.js'
import type { SagaStep } from '../domain/saga-definition.js'
import {
  awaitReply,
  beginSaga,
  enterStep,
  restartSaga,
  type SagaState,
} from '../domain/saga-state.js'
import { applyCommand } from '../domain/transitions.js'
import { slotOf } from './hold-slot.js'
import { priceForSale, ratePlanStayOf } from './live-quote.js'
import { loadOwned } from './persist.js'
import type { BookingDeps } from './ports.js'
import { compensate } from './saga/compensation.js'

export { slotOf } from './hold-slot.js'

/**
 * Hold (FR-15): tiga langkah pertama saga — priceCheck, holdLocal, holdSupplier.
 *
 * Urutannya disengaja, dan setiap langkah punya kompensasinya (tabelnya di
 * domain/saga-definition.ts):
 *
 * 1. **Periksa domain lebih dulu, tanpa efek** — langkah `priceCheck` saga.
 *    Hold untuk pemesanan yang harganya belum disetujui akan ditolak domain di
 *    akhir, setelah hold lokal dan hold supplier terlanjur diambil. Perintah
 *    hold dicoba terhadap domain dengan nilai sementara; kalau ditolak, tidak
 *    ada yang disentuh — saga pun belum dimulai.
 * 2. **Lokal (Redis).** Murah, atomik, dan menjamin US-04.
 * 3. **Supplier.** Bila gagal, hold lokal dilepas lewat kompensasi saga.
 * 4. **Harga saat hold.** Total supplier dihitung ulang menjadi harga jual dan
 *    dibandingkan dengan harga yang disetujui (G2).
 * 5. **Simpan** HELD bersama keadaan saga "menunggu pembayaran", SATU
 *    transaksi.
 *
 * Step 19: setiap langkah yang MENGUBAH sesuatu di luar basis data dicatat di
 * saga SEBELUM dijalankan, dengan sewa waktu. Proses yang mati di tengah hold
 * meninggalkan catatan itu, dan pemulihan (sweep-sagas.ts) yang
 * mengompensasinya setelah sewanya habis — kursi lokal kembali tanpa menunggu
 * kunci waktunya kedaluwarsa. Catatan yang ditulis SESUDAH langkah tidak
 * pernah ada untuk langkah yang prosesnya mati di tengahnya.
 *
 * Catatan saga yang sama menggantikan penjaga Step 17 untuk dua hold
 * serentak: hanya satu permintaan yang dapat menyimpan dimulainya saga — kunci
 * versi yang memutuskan — dan yang kalah dijawab `in_progress` sebelum
 * menyentuh Redis atau supplier.
 */

export interface HoldRequest {
  readonly userId: string
  readonly bookingId: string
  /** Ketersediaan yang terlihat di hasil pencarian. */
  readonly unitsLeft: number
}

export type HoldResult =
  | { readonly kind: 'held'; readonly booking: Booking }
  | { readonly kind: 'refused'; readonly error: BookingError }
  | { readonly kind: 'sold_out'; readonly booking: Booking }
  /** Hold untuk pemesanan ini sedang diproses permintaan lain. */
  | { readonly kind: 'in_progress'; readonly booking: Booking }
  | { readonly kind: 'price_changed'; readonly booking: Booking }
  | { readonly kind: 'retry_later'; readonly booking: Booking }
  | { readonly kind: 'not_found' }

interface Attempt {
  readonly deps: BookingDeps
  readonly booking: Booking
  readonly localUntil: Date
}

export async function placeHold(deps: BookingDeps, request: HoldRequest): Promise<HoldResult> {
  const booking = await loadOwned(deps, request.userId, request.bookingId)
  if (booking === undefined) return { kind: 'not_found' }

  // Pengulangan permintaan yang sudah berhasil: jawab dengan hasilnya.
  if (booking.status === 'HELD') return { kind: 'held', booking }

  const now = deps.clock.now()
  const localUntil = new Date(now.getTime() + deps.holdPolicy.durationMs)

  const dryRun = applyCommand(booking, {
    type: 'hold',
    at: now,
    holdRef: '-',
    heldUntil: localUntil,
  })
  if (!dryRun.ok) return { kind: 'refused', error: dryRun.error }

  const saga = await startSaga(deps, booking.id, now)
  if (saga === undefined) return { kind: 'in_progress', booking }

  const attempt = { deps, booking, localUntil }
  const local = await deps.holds.acquire({
    bookingId: booking.id,
    slot: slotOf(booking),
    capacity: request.unitsLeft,
    until: localUntil,
  })

  // `already_held` bukan hold serentak — yang itu sudah ditolak saga di atas —
  // melainkan kursi sisa percobaan pemesanan INI sendiri. Saga milik
  // permintaan ini sekarang, jadi kursinya dipakai, bukan diambil dua kali.
  if (local === 'sold_out') {
    await abort(attempt, saga, { stoppedAt: 'holdLocal', reason: 'kursi lokal habis' })
    return { kind: 'sold_out', booking }
  }

  return await holdAtSupplier(attempt, saga)
}

/** Niat hold lokal dicatat — saga baru, atau saga yang dimulai ulang. */
async function startSaga(
  deps: BookingDeps,
  bookingId: string,
  at: Date,
): Promise<SagaState | undefined> {
  const previous = await deps.sagas.find(bookingId)
  const saga =
    previous === undefined
      ? beginSaga(bookingId, at, deps.sagaPolicy.leaseMs)
      : restartSaga(previous, at, deps.sagaPolicy.leaseMs)
  if (saga === undefined) return undefined

  const outcome = await deps.sagas.commit({ bookingId, at, saga })
  return outcome === 'committed' ? saga : undefined
}

async function holdAtSupplier(attempt: Attempt, local: SagaState): Promise<HoldResult> {
  const { deps, booking } = attempt
  const saga = enterStep(local, 'holdSupplier', deps.clock.now(), deps.sagaPolicy.leaseMs)

  // Sewa hold lokal habis dan pemulih sudah mengambil alih saga ini: proses
  // ini dianggap mati. Kursinya milik kompensasi pemulih sekarang.
  if (
    (await deps.sagas.commit({ bookingId: booking.id, at: saga.updatedAt, saga })) !== 'committed'
  ) {
    return { kind: 'in_progress', booking }
  }

  const answer = await deps.suppliers.hold({
    ...ratePlanStayOf(booking),
    guests: booking.guests.count,
  })
  if (answer.kind !== 'ok') {
    await abort(attempt, saga, {
      stoppedAt: 'holdSupplier',
      through: 'holdLocal',
      reason: `hold supplier: ${answer.kind}`,
    })
    return answer.kind === 'rejected'
      ? { kind: 'sold_out', booking }
      : { kind: 'retry_later', booking }
  }

  const priced = await priceForSale(deps, booking, answer.value.total)
  if (priced.kind !== 'quoted' || !isSameAmount(priced.price.total, booking.price.total)) {
    const changed = priced.kind === 'quoted'
    await abort(attempt, saga, {
      stoppedAt: 'holdSupplier',
      through: 'holdSupplier',
      reason: changed ? 'harga berubah saat hold' : 'harga jual tidak dapat dihitung',
    })
    return changed ? { kind: 'price_changed', booking } : { kind: 'retry_later', booking }
  }

  const heldUntil = effectiveHoldUntil(attempt.localUntil, answer.value.expiresAt)
  return await saveHold(attempt, saga, { holdRef: answer.value.holdRef, heldUntil })
}

/** HELD dan "menunggu pembayaran" tersimpan bersama, atau tidak sama sekali. */
async function saveHold(
  attempt: Attempt,
  saga: SagaState,
  held: { readonly holdRef: string; readonly heldUntil: Date },
): Promise<HoldResult> {
  const { deps, booking } = attempt
  const at = deps.clock.now()
  const change = applyCommand(booking, { type: 'hold', at, ...held })

  // Hold supplier yang sudah kedaluwarsa saat tiba, misalnya.
  if (!change.ok) {
    await abort(attempt, saga, {
      stoppedAt: 'holdSupplier',
      through: 'holdSupplier',
      reason: change.error.message,
    })
    return { kind: 'refused', error: change.error }
  }

  const waiting = awaitReply(saga, 'awaitPayment', at, undefined)
  const outcome = await deps.sagas.commit({
    bookingId: booking.id,
    at,
    change: change.value,
    saga: waiting,
  })

  // Pemesanan berpindah oleh pihak lain di antara langkah 1 dan 5 —
  // dibatalkan pengguna, misalnya. Pemesanan yang dikembalikan adalah yang
  // dikenal permintaan ini; keadaan yang menang dibaca klien lewat GET.
  if (outcome !== 'committed') {
    await abort(attempt, saga, {
      stoppedAt: 'holdSupplier',
      through: 'holdSupplier',
      reason: 'pemesanan berpindah di tengah hold',
    })
    return { kind: 'in_progress', booking }
  }

  await deps.holds.shorten(booking.id, held.heldUntil)
  return { kind: 'held', booking: change.value.booking }
}

interface Abort {
  readonly stoppedAt: SagaStep
  /** Langkah terakhir yang efeknya harus dibalik; tidak ada bila belum ada efek. */
  readonly through?: SagaStep
  readonly reason: string
}

/** Percobaan hold dihentikan: kompensasi mundur dari langkah terakhir yang berhasil. */
async function abort(attempt: Attempt, saga: SagaState, stop: Abort): Promise<void> {
  const { deps, booking } = attempt

  await compensate(deps, {
    booking,
    saga,
    start: {
      through: stop.through,
      stoppedAt: stop.stoppedAt,
      at: deps.clock.now(),
      reason: stop.reason,
    },
  })
}
