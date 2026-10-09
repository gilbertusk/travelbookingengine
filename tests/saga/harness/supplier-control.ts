import { createSkyAdapter, createSupplierHttp } from '@tbe/supplier-adapters'
import { getContainerRuntimeClient } from 'testcontainers'
import { request } from 'undici'
import { z } from 'zod'
import { eventually } from './waits.js'

/**
 * Panel kendali mock-supplier dan kontainernya, dari dalam uji.
 *
 * Dua cara membuat supplier gagal, dan keduanya dibutuhkan:
 *
 * - Panel kendali (`/admin/...`): kegagalan per operasi yang terjadwal —
 *   timeout, jawaban yang hilang setelah pemesanan tersimpan, 500.
 * - Kontainer DIHENTIKAN: koneksi ditolak di tingkat TCP. Inilah "supplier
 *   mati" yang sesungguhnya. `/admin/sky/down` memutus koneksi SETELAH
 *   terbentuk, dan sejak Step 20 itu digolongkan tidak pasti — bukan mati.
 */

export type ScriptedMode =
  | 'timeout'
  | 'server_error'
  | 'unavailable'
  | 'connection_reset'
  | 'malformed'
  | 'truncated'
  | 'lose_response'

export type SupplierOperation = 'search' | 'rate' | 'hold' | 'book' | 'cancel' | 'lookup'

const holdSchema = z.object({ ref: z.string(), supplier: z.string(), expiresAtMs: z.number() })
const bookingSchema = z.object({
  ref: z.string(),
  supplier: z.string(),
  holdRef: z.string(),
  status: z.enum(['CONFIRMED', 'CANCELLED']),
  idempotencyKey: z.string(),
})
const reservationsSchema = z.object({
  holds: z.array(holdSchema),
  bookings: z.array(bookingSchema),
})
const availabilitySchema = z.object({
  results: z.array(
    z.object({
      hotelId: z.string(),
      rooms: z.array(z.object({ rates: z.array(z.object({ rateId: z.string() })) })),
    }),
  ),
})

export type MockHold = z.infer<typeof holdSchema>
export type MockBooking = z.infer<typeof bookingSchema>

export interface RatePlan {
  readonly propertyId: string
  readonly ratePlanRef: string
  readonly city: string
}

export interface SupplierControl {
  readonly url: string
  schedule(
    supplier: string,
    fault: { operation: SupplierOperation; mode: ScriptedMode; times?: number },
  ): Promise<void>
  reservations(): Promise<{ holds: readonly MockHold[]; bookings: readonly MockBooking[] }>
  /** Rate plan SKY pertama yang tersedia untuk tanggal itu — seperti hasil pencarian. */
  findSkyRatePlan(stay: { checkIn: string; checkOut: string }): Promise<RatePlan>
  /**
   * Mengembalikan panel kendali ke keadaan awal, lalu MENENANGKAN SKY:
   * pergeseran harga dan kegagalan acak bawaan profilnya dimatikan.
   *
   * SKY bawaannya menggeser harga 8% dari price check. Tanpa ini, persetujuan
   * harga di pembangun data uji kadang dijawab "harga berubah lagi" — uji yang
   * gagal satu dari dua belas kali, persis bentuk flaky yang ditolak Step 20.
   * Pergeseran harga tetap diuji, di Step 17, dengan sengaja.
   */
  reset(): Promise<void>
  /** Mengosongkan hold, pemesanan, dan stok di mock-supplier — antara skenario uji beban. */
  resetInventory(): Promise<void>
  /** Stok tetap untuk satu rate plan SKY, melampaui batas dasar (Step 22). */
  setSkyStock(rateRef: string, units: number): Promise<void>
  /**
   * SKY "mati" lewat panel kendali: koneksi diterima lalu diputus. Sejak Step
   * 20 digolongkan TIDAK PASTI — bedanya dengan kontainer yang dihentikan.
   */
  panelDown(): Promise<void>
  /**
   * SKY menjawab 503 untuk SETIAP permintaan. Berbeda dari `panelDown`:
   * jawaban 503 adalah kepastian bahwa permintaannya tidak dikerjakan, jadi
   * pemesanan yang gagal dikonfirmasi berakhir di refund (US-03), bukan di
   * peninjauan (US-05). `panelUp` tidak mengembalikannya — pakai `reset`.
   */
  panelRefuse(): Promise<void>
  panelUp(): Promise<void>
  /**
   * Hold lalu book LANGSUNG di SKY, di luar saga, dengan kunci idempotensi
   * pemesanan — pemesanan supplier yang tidak pernah diketahui saga. Bentuk
   * yang sama dengan perintah `supplier.confirm` dari dead letter yang
   * diputar ulang operator setelah saga memutuskan refund. Mengembalikan
   * booking reference-nya.
   */
  bookBehindSaga(booking: {
    readonly bookingId: string
    readonly ratePlan: RatePlan
    readonly stay: { readonly checkIn: string; readonly checkOut: string }
  }): Promise<string>
  stopContainer(): Promise<void>
  startContainer(): Promise<void>
  ensureRunning(): Promise<void>
}

const CITY = 'Bali'

export function createSupplierControl(mock: {
  readonly url: string
  readonly containerId: string
}): SupplierControl {
  let stopped = false
  let starting: Promise<void> | undefined

  async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const response = await request(`${mock.url}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const payload: unknown = await response.body.json()
    if (response.statusCode >= 400) {
      throw new Error(
        `${method} ${path} -> ${String(response.statusCode)}: ${JSON.stringify(payload)}`,
      )
    }
    return payload
  }

  async function container() {
    const client = await getContainerRuntimeClient()
    return { client, handle: client.container.getById(mock.containerId) }
  }

  const control: SupplierControl = {
    url: mock.url,
    async schedule(supplier, fault) {
      await call('POST', `/admin/${supplier.toLowerCase()}/faults`, fault)
    },
    async reservations() {
      return reservationsSchema.parse(await call('GET', '/admin/reservations'))
    },
    async findSkyRatePlan(stay) {
      const found = availabilitySchema.parse(
        await call('POST', '/sky/availability', { city: CITY, ...stay, guests: 2 }),
      )
      const hotel = found.results[0]
      const rate = hotel?.rooms[0]?.rates[0]
      if (hotel === undefined || rate === undefined) throw new Error('SKY tidak punya rate plan')
      return { propertyId: hotel.hotelId, ratePlanRef: rate.rateId, city: CITY }
    },
    async bookBehindSaga(booking) {
      const sky = createSkyAdapter(createSupplierHttp('SKY', { baseUrl: `${mock.url}/sky` }))
      const hold = await sky.hold(booking.ratePlan.ratePlanRef, booking.stay, 2)
      if (!hold.ok) throw new Error(`hold langsung di SKY gagal: ${hold.error.kind}`)
      const booked = await sky.book(
        hold.value.supplierHoldId,
        { fullName: 'Budi Santoso' },
        booking.bookingId,
      )
      if (!booked.ok) throw new Error(`book langsung di SKY gagal: ${booked.error.kind}`)
      return booked.value.bookingReference
    },
    async resetInventory() {
      await call('POST', '/admin/inventory/reset', {})
    },
    async setSkyStock(rateRef, units) {
      await call('POST', '/admin/sky/stock', { rateRef, units })
    },
    async panelDown() {
      await call('POST', '/admin/sky/down', {})
    },
    async panelUp() {
      await call('POST', '/admin/sky/up', {})
    },
    async panelRefuse() {
      await call('POST', '/admin/sky/failure', { rate: 1, mode: 'unavailable' })
    },
    async reset() {
      await call('POST', '/admin/reset', {})
      await call('POST', '/admin/sky/price-drift', { rate: 0 })
      await call('POST', '/admin/sky/failure', { rate: 0, mode: 'server_error' })
    },
    async stopContainer() {
      const { client, handle } = await container()
      await client.container.stop(handle, { timeout: 0 })
      stopped = true
      // Kontainer yang berhenti BELUM tentu berarti koneksi ditolak. Di Docker
      // Desktop Windows, penerus port IPv6 (wslrelay) masih mendengarkan
      // setelah kontainernya berhenti, menerima koneksi, lalu memutusnya —
      // ECONNRESET, yang sejak Step 20 digolongkan TIDAK PASTI. Uji "supplier
      // mati" di atas penerus itu menguji skenario lain (US-05, bukan US-03).
      // Ditemukan pada putaran pertama Step 20: pemesanan berakhir di
      // NEEDS_REVIEW alih-alih REFUNDED. Karena itu alamatnya 127.0.0.1
      // (global-setup.ts), dan di sini ditunggu keadaan yang diklaim skenario
      // — penolakan di tingkat TCP — bukan jeda tebakan.
      await eventually('mock-supplier menolak koneksi', async () => {
        return (await transportFailure(mock.url)) === 'ECONNREFUSED'
      })
    },
    async startContainer() {
      const { client, handle } = await container()
      await client.container.start(handle)
      stopped = false
      await eventually('mock-supplier menyala kembali', async () => {
        try {
          const response = await request(`${mock.url}/health/live`)
          await response.body.dump()
          return response.statusCode === 200
        } catch {
          return false
        }
      })
    },
    async ensureRunning() {
      if (!stopped) return
      // Dua uji serentak (supplier-down.test.ts) dapat meminta ini bersamaan.
      // Tanpa penyalaan bersama, keduanya melihat `stopped` dan yang kedua
      // ditolak Docker "container already started" — kesalahan sendiri yang
      // ditemukan putaran kedua Step 20.
      starting ??= control.startContainer().finally(() => {
        starting = undefined
      })
      await starting
    },
  }

  return control
}

/**
 * Kode galat transport saat menghubungi supplier, atau `undefined` bila ia
 * menjawab. Dicari sampai ke `cause`, seperti classifyTransportFailure.
 */
async function transportFailure(url: string): Promise<string | undefined> {
  try {
    const response = await request(`${url}/health/live`)
    await response.body.dump()
    return undefined
  } catch (error) {
    return codeOf(error)
  }
}

function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  if ('code' in error && typeof error.code === 'string') return error.code
  return 'cause' in error ? codeOf(error.cause) : undefined
}
