/**
 * US-04 — seribu pengguna memperebutkan sepuluh kamar (M5).
 *
 * Setiap VU adalah satu pengguna: price check dan persetujuan harga lebih
 * dulu, lalu SELURUHNYA menunggu titik waktu yang sama dan menahan kamar
 * bersamaan. Price check tidak ikut diperebutkan — ia membaca harga, tidak
 * mengurangi apa pun — dan menyebarnya di depan membuat seribu hold benar-
 * benar tiba dalam jendela yang sama, bukan tersebar mengikuti latensi
 * supplier.
 *
 * Yang menang membayar. Kebenarannya tidak dinilai di sini: k6 hanya
 * menghitung jawaban HTTP. Pelari (tests/saga/load) memeriksa basis data,
 * Redis, dan mock-supplier setelah semuanya tuntas.
 */
import { check, sleep } from 'k6'
import { Counter, Trend } from 'k6/metrics'
import { hold, pay, priceChecked, uuid, waitUntil } from './lib/booking.mjs'

const VUS = Number(__ENV.VUS ?? 1000)
/** Ketersediaan yang dilihat pengguna di hasil pencarian. */
const UNITS = Number(__ENV.UNITS ?? 10)
/** Jendela untuk seluruh price check sebelum hold serentak. */
const PRICE_CHECK_WINDOW_MS = Number(__ENV.PRICE_CHECK_WINDOW_MS ?? 120_000)
/**
 * Price check disebar acak di awal jendela. Seribu koneksi TCP baru di
 * milidetik yang sama melampaui antrean listen Node (511) dan ditolak sistem
 * operasi sebelum aplikasi melihatnya — pengukuran antrean soket, bukan
 * pemesanan. Price check tidak diperebutkan, jadi menyebarnya tidak
 * melemahkan uji.
 */
const PRICE_CHECK_SPREAD_MS = Number(__ENV.PRICE_CHECK_SPREAD_MS ?? 60_000)
/** Seluruh hold tiba dalam satu detik — jauh lebih sempit dari satu hold (milidetik di Redis). */
const HOLD_SPREAD_MS = Number(__ENV.HOLD_SPREAD_MS ?? 1_000)

const holdDuration = new Trend('hold_duration', true)
const held = new Counter('hold_held')
const soldOut = new Counter('hold_sold_out')
const holdOther = new Counter('hold_other')
const notChecked = new Counter('price_check_failed')
const paid = new Counter('payment_sent')

export const options = {
  scenarios: {
    rebutan: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: 1,
      maxDuration: '15m',
    },
  },
  setupTimeout: '30s',
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
}

export function setup() {
  return { holdAt: Date.now() + PRICE_CHECK_WINDOW_MS }
}

export default function contention(shared) {
  sleep((Math.random() * PRICE_CHECK_SPREAD_MS) / 1000)
  const userId = uuid()
  const booking = priceChecked(userId, `k6-rebutan-${String(__VU)}-${uuid()}`)
  if (!check(booking, { 'price check terverifikasi': (value) => value !== null })) {
    notChecked.add(1)
    return
  }

  waitUntil(shared.holdAt + Math.random() * HOLD_SPREAD_MS)

  const response = hold(userId, booking.id, UNITS)
  holdDuration.add(response.timings.duration)

  if (response.status === 200) {
    held.add(1)
    if (pay(userId, response.json('data')) !== null) paid.add(1)
    return
  }
  if (response.status === 409 && response.json('error.code') === 'SOLD_OUT') {
    soldOut.add(1)
    return
  }
  holdOther.add(1)
  // eslint-disable-next-line no-console -- log k6; disimpan pelari ke results/*.k6.log
  console.warn(
    `gagal hold: status=${String(response.status)} ${String(response.body).slice(0, 120)}`,
  )
}
