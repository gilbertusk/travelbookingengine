/**
 * Langkah alur pemesanan untuk uji beban Step 22.
 *
 * Permintaan dikirim LANGSUNG ke booking-service dan payment-service, dengan
 * identitas di header `x-tbe-user-id` — header yang sama yang dipasang
 * api-gateway setelah memverifikasi token. Gateway sengaja dilewati: yang
 * diukur di sini jaminan konkurensi pemesanan (M5, M6), bukan pembatas laju
 * gateway, yang akan menolak seribu permintaan dari satu alamat IP lebih dulu
 * dan membuat uji rebutan tidak pernah sampai ke rebutannya.
 *
 * Pembayaran meniru Midtrans: niat pembayaran dibuka lewat booking-service
 * (yang meminta payment-service menagih pengganti Midtrans), lalu notifikasi
 * bertanda tangan dikirim ke webhook payment-service — persis bentuk yang
 * dikirim Midtrans, dengan server key pengganti yang sama.
 */
import http from 'k6/http'
import crypto from 'k6/crypto'
import { sleep } from 'k6'
import { Counter } from 'k6/metrics'

export const BOOKING_URL = __ENV.BOOKING_URL ?? 'http://host.docker.internal:4006'
export const PAYMENT_URL = __ENV.PAYMENT_URL ?? 'http://host.docker.internal:4007'
const SERVER_KEY = __ENV.MIDTRANS_SERVER_KEY ?? ''

/** Rate plan dan masa inap yang diperebutkan, disiapkan pelari sebelum k6 berjalan. */
export const STAY = {
  supplier: __ENV.SUPPLIER ?? 'SKY',
  propertyId: __ENV.PROPERTY_ID ?? '',
  city: __ENV.CITY ?? 'Bali',
  ratePlanRef: __ENV.RATE_PLAN_REF ?? '',
  checkIn: __ENV.CHECK_IN ?? '',
  checkOut: __ENV.CHECK_OUT ?? '',
}

/** UUID v4 — booking-service menolak identitas yang bukan UUID. */
export function uuid() {
  const bytes = new Uint8Array(crypto.randomBytes(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function headers(userId) {
  return { 'content-type': 'application/json', 'x-tbe-user-id': userId }
}

function data(response) {
  try {
    return response.json('data')
  } catch {
    return null
  }
}

/**
 * Price check lalu persetujuan harga — alur US-02 yang sama dengan pengguna
 * sungguhan. Harga "yang dilihat" sengaja salah (Rp 1): jawaban pertama
 * selalu `changed` dengan harga jual sebenarnya, lalu disetujui.
 * Mengembalikan pemesanan terverifikasi, atau `null`.
 */
export function priceChecked(userId, idempotencyKey, guests = 2) {
  const body = {
    idempotencyKey,
    ...STAY,
    // Ketentuan tawaran sebagai bahan e-voucher (Step 23). Uji beban tidak
    // memeriksanya; nilainya cukup sah.
    offer: {
      roomTypeName: 'Kamar Uji Beban',
      ratePlanName: 'Tarif Uji Beban',
      breakfastIncluded: false,
      cancellationPolicy: { refundable: false },
    },
    guest: { fullName: 'Tamu Uji Beban', email: 'beban@example.test', count: guests },
    displayedTotal: { amountMinor: 1, currency: 'IDR' },
  }
  const first = retrying(() =>
    http.post(`${BOOKING_URL}/bookings/price-check`, JSON.stringify(body), {
      headers: headers(userId),
      tags: { langkah: 'price_check' },
      responseCallback: http.expectedStatuses(200, 503),
    }),
  )
  const checked = first.status === 200 ? data(first) : null
  if (checked === null) return failed('price_check', first)
  if (checked.priceCheck?.outcome === 'unchanged') return checked

  const accepted = retrying(() =>
    http.post(
      `${BOOKING_URL}/bookings/price-check/accept`,
      JSON.stringify({ bookingId: checked.id }),
      {
        headers: headers(userId),
        tags: { langkah: 'price_check' },
        responseCallback: http.expectedStatuses(200, 503),
      },
    ),
  )
  const booking = accepted.status === 200 ? data(accepted) : null
  // Persetujuan yang ditolak karena salinan lain sudah menyetujui lebih dulu:
  // price check ulang dengan kunci yang sama membaca keadaan sekarang — yang
  // juga dilakukan halaman pemesanan pada "Coba lagi".
  if (booking === null && accepted.status === 409) return recheck(userId, body)
  if (booking === null) return failed('accept', accepted)

  return booking.priceCheck?.outcome === 'unchanged' ? booking : failed('accept', accepted)
}

function recheck(userId, body) {
  const again = retrying(() =>
    http.post(`${BOOKING_URL}/bookings/price-check`, JSON.stringify(body), {
      headers: headers(userId),
      tags: { langkah: 'price_check' },
      responseCallback: http.expectedStatuses(200, 503),
    }),
  )
  const booking = again.status === 200 ? data(again) : null

  return booking?.priceCheck?.outcome === 'unchanged' ? booking : failed('recheck', again)
}

/**
 * Mencatat penyebab kegagalan ke log k6 — satu baris per kegagalan, dengan
 * status dan kode galatnya. Tanpa ini, "939 price check gagal" tidak dapat
 * dibedakan antara supplier yang lambat, pricing-service yang penuh, dan
 * basis data yang kehabisan koneksi.
 */
function failed(step, response) {
  let code = ''
  try {
    code = response.json('error.code') ?? ''
  } catch {
    code = response.error_code === 0 ? '' : `k6:${String(response.error_code)}`
  }
  // eslint-disable-next-line no-console -- console adalah log k6; pelari menyimpannya ke results/*.k6.log
  console.warn(
    `gagal ${step}: status=${String(response.status)} kode=${code} ${response.error ?? ''}`,
  )
  return null
}

/** Hold. Jawaban mentahnya dikembalikan: 409 SOLD_OUT adalah hasil yang diukur, bukan galat. */
export function hold(userId, bookingId, unitsLeft) {
  return retrying(() =>
    http.post(`${BOOKING_URL}/bookings/hold`, JSON.stringify({ bookingId, unitsLeft }), {
      headers: headers(userId),
      tags: { langkah: 'hold' },
      // 409 dan 503 dicatat sebagai jawaban, bukan kegagalan HTTP.
      responseCallback: http.expectedStatuses(200, 409, 503),
    }),
  )
}

/**
 * Percobaan untuk jawaban 503 — booking-service yang penuh, atau supplier yang
 * belum menjawab — dan untuk koneksi yang ditolak sebelum sampai ke aplikasi
 * (status 0): antrean listen yang penuh saat ratusan koneksi baru tiba di
 * detik yang sama.
 */
const RETRIES = Number(__ENV.RETRIES ?? 8)

/**
 * Mengulang permintaan yang dijawab 503, seperti klien yang baik: jeda yang
 * memanjang dengan acakan, supaya seribu klien yang ditolak bersamaan tidak
 * kembali bersamaan pula. Mengulang AMAN karena setiap permintaan alur ini
 * idempoten — termasuk yang sempat sampai sebelum koneksinya putus: price check terhadap kunci idempotensi, hold dan persetujuan
 * terhadap pemesanan yang sama.
 */
const paymentOpenRetried = new Counter('payment_open_retried')

export function retrying(send) {
  let response = send()
  for (let attempt = 0; attempt < RETRIES && retryable(response.status); attempt += 1) {
    sleep(Math.min(0.25 * 2 ** attempt, 4) * (0.5 + Math.random()))
    response = send()
  }
  return response
}

/**
 * Membuka pembayaran lalu mengirim notifikasi `settlement` bertanda tangan.
 * Mengembalikan pengenal pembayaran, atau `null`.
 */
export function pay(userId, booking, options = {}) {
  const open = () =>
    http.post(`${BOOKING_URL}/bookings/${booking.id}/payment`, null, {
      headers: headers(userId),
      tags: { langkah: 'buka_pembayaran' },
      responseCallback: http.expectedStatuses(200, 409, 503),
    })

  // 503 PAYMENT_UNAVAILABLE adalah jawaban yang DIRANCANG untuk diulang:
  // payment-service mengetahui harga dari peristiwa Kafka, dan pembayaran yang
  // dibuka sepersekian detik setelah hold dapat mendahului peristiwanya. Versi
  // pertama tidak mengulang — 12 dari 58 pemesanan tertahan lalu kedaluwarsa
  // tanpa pernah dibayar, dan angkanya terbaca seperti akibat supplier mati.
  // Berapa kali pengulangan itu terjadi dicatat, bukan disembunyikan.
  let opened = open()
  for (let attempt = 0; attempt < RETRIES && retryable(opened.status); attempt += 1) {
    paymentOpenRetried.add(1)
    sleep(Math.min(0.25 * 2 ** attempt, 4) * (0.5 + Math.random()))
    opened = open()
  }
  const payment = opened.status === 200 ? data(opened) : null
  if (payment === null) return null

  notify(payment.paymentId, booking.price.total.amountMinor, options.transactionId ?? uuid())
  return payment.paymentId
}

/** Notifikasi Midtrans. Tanda tangan: SHA-512(order_id + status_code + gross_amount + server_key). */
export function notify(orderId, amountMinor, transactionId) {
  // IDR bereksponen 0; Midtrans tetap menulis dua desimal.
  const grossAmount = `${String(amountMinor)}.00`
  const statusCode = '200'
  const signature = crypto.sha512(`${orderId}${statusCode}${grossAmount}${SERVER_KEY}`, 'hex')

  return http.post(
    `${PAYMENT_URL}/webhooks/midtrans`,
    JSON.stringify({
      order_id: orderId,
      transaction_id: transactionId,
      transaction_status: 'settlement',
      fraud_status: 'accept',
      status_code: statusCode,
      gross_amount: grossAmount,
      currency: 'IDR',
      signature_key: signature,
    }),
    { headers: { 'content-type': 'application/json' }, tags: { langkah: 'webhook' } },
  )
}

/** Menunggu sampai titik waktu bersama — seluruh VU menyerbu bersamaan. */
export function waitUntil(epochMs) {
  const remaining = epochMs - Date.now()
  if (remaining > 0) sleep(remaining / 1000)
}

function retryable(status) {
  return status === 503 || status === 0
}
