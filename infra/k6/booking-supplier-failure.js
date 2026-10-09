/**
 * Supplier mati di tengah beban pemesanan normal (M6).
 *
 * Pemesanan tiba dengan laju tetap; pelari (tests/saga/load) mematikan SKY
 * lewat panel kendali mock-supplier di tengah jalan dan menyalakannya kembali
 * hanya setelah seluruh pemesanan tuntas. k6 hanya mengirim alurnya; hasil
 * akhirnya (CONFIRMED, NEEDS_REVIEW, CANCELLED, EXPIRED) dibaca pelari dari
 * basis data.
 */
import { sleep } from 'k6'
import { Counter, Trend } from 'k6/metrics'
import { hold, pay, priceChecked, uuid } from './lib/booking.mjs'

const RATE = Number(__ENV.RATE ?? 2)
const DURATION = __ENV.DURATION ?? '60s'
const UNITS = Number(__ENV.UNITS ?? 1_000)
/**
 * Lama pengguna mengisi formulir pembayaran, acak dari nol sampai sekian detik.
 *
 * Tanpa jeda ini seluruh alur selesai dalam satu detik, dan pada saat supplier
 * mati tidak ada satu pun pemesanan yang sedang berada di antara hold dan
 * konfirmasi: yang datang sesudahnya gagal di price check, yang datang
 * sebelumnya sudah terkonfirmasi. Jalan pertama skenario ini berakhir dengan
 * nol refund dan nol peninjauan — "supplier mati setelah pembayaran" yang
 * tidak pernah menyentuh pembayaran. Pengguna sungguhan tidak membayar dalam
 * 90 milidetik.
 */
const THINK_MAX_S = Number(__ENV.THINK_MAX_S ?? 20)

const holdDuration = new Trend('hold_duration', true)
const started = new Counter('alur_dimulai')
const paid = new Counter('payment_sent')
const notHeld = new Counter('hold_tidak_berhasil')

export const options = {
  scenarios: {
    normal: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
}

export default function normalLoad() {
  started.add(1)
  const userId = uuid()
  const booking = priceChecked(userId, `k6-gagal-${uuid()}`)
  if (booking === null) return

  const response = hold(userId, booking.id, UNITS)
  holdDuration.add(response.timings.duration)
  if (response.status !== 200) {
    notHeld.add(1)
    return
  }

  sleep(Math.random() * THINK_MAX_S)
  if (pay(userId, response.json('data')) !== null) paid.add(1)
}
