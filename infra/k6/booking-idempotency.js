/**
 * FR-18, US-05 — permintaan yang sama, dikirim serentak berkali-kali.
 *
 * KEYS pemesanan logis; setiap pemesanan dikirim COPIES VU sekaligus dengan
 * pengguna yang sama dan kunci idempotensi yang sama — klik ganda, tab ganda,
 * dan klien yang mengulang permintaan yang jawabannya hilang. Setiap salinan
 * menjalankan SELURUH alur: price check, hold, buka pembayaran. Notifikasi
 * pembayaran dikirim dua kali dengan transaction_id yang sama, seperti
 * Midtrans yang mengirim ulang notifikasi.
 *
 * Yang benar: tepat satu pemesanan, satu hold, satu pembayaran, dan satu
 * pemesanan di supplier per kunci — diperiksa pelari setelah semuanya tuntas.
 */
import { Counter } from 'k6/metrics'
import { hold, notify, priceChecked, uuid, waitUntil } from './lib/booking.mjs'
import http from 'k6/http'
import { sleep } from 'k6'

const KEYS = Number(__ENV.KEYS ?? 50)
const COPIES = Number(__ENV.COPIES ?? 10)
const RUN_ID = __ENV.RUN_ID ?? 'run'
/** Kapasitas lokal yang dilaporkan pencarian; stok supplier disiapkan pelari. */
const UNITS = Number(__ENV.UNITS ?? 1_000)

const sent = new Counter('salinan_dikirim')
const notified = new Counter('notifikasi_dikirim')

export const options = {
  scenarios: {
    salinan: {
      executor: 'per-vu-iterations',
      vus: KEYS * COPIES,
      iterations: 1,
      maxDuration: '10m',
    },
  },
}

/** Berapa kali salinan yang dijawab "sedang diproses" mencoba lagi. */
const HOLD_POLLS = Number(__ENV.HOLD_POLLS ?? 20)

/**
 * Hold, diulang selama jawabannya 409 HOLD_IN_PROGRESS.
 *
 * Sembilan dari sepuluh salinan PASTI dijawab begitu: hanya satu permintaan
 * yang boleh mengerjakan hold sebuah pemesanan. "Sedang diproses" bukan
 * penolakan — klien sungguhan menunggu lalu bertanya lagi, dan pengulangan
 * atas hold yang sudah berhasil dijawab dengan hasilnya, bukan hold kedua.
 *
 * Versi pertama skenario ini berhenti pada jawaban pertama. Akibatnya yang
 * membuka pembayaran hanya salinan pemenang, sedangkan yang mengirim
 * notifikasi hanya salinan ke-0 dan ke-1 — bila pemenangnya salinan lain,
 * tidak ada yang membayar, pemesanannya kedaluwarsa, dan ujinya gagal karena
 * skenarionya sendiri, bukan karena sistemnya.
 */
function holdSettled(userId, bookingId) {
  let response = hold(userId, bookingId, UNITS)
  for (let poll = 0; poll < HOLD_POLLS && inProgress(response); poll += 1) {
    sleep(0.5 + Math.random() * 0.5)
    response = hold(userId, bookingId, UNITS)
  }
  return response
}

function inProgress(response) {
  if (response.status !== 409) return false
  try {
    return response.json('error.code') === 'HOLD_IN_PROGRESS'
  } catch {
    return false
  }
}

export function setup() {
  // Seluruh salinan berangkat bersamaan, beberapa detik setelah VU terakhir siap.
  return { startAt: Date.now() + 5_000, users: Array.from({ length: KEYS }, () => uuid()) }
}

export default function idempotency(shared) {
  const keyIndex = (__VU - 1) % KEYS
  const copy = Math.floor((__VU - 1) / KEYS)
  const userId = shared.users[keyIndex]
  const key = `k6-idem-${RUN_ID}-${String(keyIndex)}`

  waitUntil(shared.startAt)
  sent.add(1)

  const booking = priceChecked(userId, key)
  if (booking === null) return

  const held = holdSettled(userId, booking.id)
  const current = held.status === 200 ? held.json('data') : booking
  if (held.status !== 200) {
    // eslint-disable-next-line no-console -- log k6; disimpan pelari ke results/*.k6.log
    console.warn(`hold salinan: status=${String(held.status)} ${String(held.body).slice(0, 120)}`)
  }

  const opened = http.post(
    `${__ENV.BOOKING_URL ?? 'http://host.docker.internal:4006'}/bookings/${booking.id}/payment`,
    null,
    {
      headers: { 'content-type': 'application/json', 'x-tbe-user-id': userId },
      tags: { langkah: 'buka_pembayaran' },
      responseCallback: http.expectedStatuses(200, 409, 503),
    },
  )
  if (opened.status !== 200 || copy > 1) return

  // Dua salinan pertama mengirim notifikasi dengan transaction_id yang SAMA:
  // Midtrans yang mengirim ulang, bukan pembayaran kedua.
  const paymentId = opened.json('data.paymentId')
  notify(paymentId, current.price.total.amountMinor, `trx-${RUN_ID}-${String(keyIndex)}`)
  notified.add(1)
}
