import { nextStay } from '../harness/journey.js'
import { startSystem, type System } from '../harness/system.js'
import type { RatePlan } from '../harness/supplier-control.js'

/**
 * Sistem untuk uji beban: sistem yang SAMA dengan uji saga (empat service
 * sebagai proses OS di atas kontainer Testcontainers), dengan tiga
 * penyesuaian.
 *
 * - **Port standar.** Prometheus di infra/prometheus.yml mengikis 4004–4007;
 *   dengan port acak, uji beban tidak terlihat di Grafana.
 * - **Telemetri menyala.** Trace dikirim ke Jaeger di localhost:4318 bila
 *   `pnpm infra:up` menjalankannya; bila tidak, pengirimnya gagal diam-diam
 *   dan tidak mengubah hasil.
 * - **Pembatas laju ke supplier dinaikkan.** Bawaannya 20 per detik — benar
 *   untuk melindungi supplier sungguhan, tetapi seribu price check lalu
 *   habis menunggu kuota dan uji rebutan tidak pernah sampai ke rebutannya.
 *   Yang diuji di sini jaminan konkurensi pemesanan, bukan pembatas laju;
 *   pembatas laju punya ujinya sendiri di supplier-service.
 */
export const LOAD_PORTS = { supplier: 4004, pricing: 4005, booking: 4006, payment: 4007 } as const

export async function startLoadSystem(): Promise<System> {
  return await startSystem({
    ports: LOAD_PORTS,
    env: { OTEL_ENABLED: 'true', LOG_LEVEL: 'info' },
    serviceEnv: {
      supplier: { SUPPLIER_RATE_PER_SECOND: '2000', SUPPLIER_RATE_BURST: '4000' },
      // Batas waktu PRODUKSI, bukan versi pendek uji saga: di bawah beban satu
      // hold dapat memakan beberapa detik, dan sewa 13 detik uji saga membuat
      // pemulih mengambil alih hold yang prosesnya masih bekerja.
      booking: { LOG_LEVEL: 'info', UPSTREAM_TIMEOUT_MS: '5000', SAGA_STEP_LEASE_MS: '60000' },
    },
  })
}

export interface Arena {
  readonly stay: { readonly checkIn: string; readonly checkOut: string }
  readonly ratePlan: RatePlan
}

/** Satu rate plan SKY dan satu masa inap, dengan stok yang ditetapkan. */
export async function prepareArena(system: System, units: number): Promise<Arena> {
  await system.supplier.resetInventory()
  await system.supplier.reset()
  const stay = await nextStay(system)
  const ratePlan = await system.supplier.findSkyRatePlan(stay)
  await system.supplier.setSkyStock(ratePlan.ratePlanRef, units)
  return { stay, ratePlan }
}

/** Env yang dibaca infra/k6/lib/booking.mjs. */
export function k6Env(system: System, arena: Arena): Record<string, string> {
  return {
    BOOKING_URL: `http://host.docker.internal:${String(LOAD_PORTS.booking)}`,
    PAYMENT_URL: `http://host.docker.internal:${String(LOAD_PORTS.payment)}`,
    MIDTRANS_SERVER_KEY: system.midtrans.serverKey,
    SUPPLIER: 'SKY',
    PROPERTY_ID: arena.ratePlan.propertyId,
    CITY: arena.ratePlan.city,
    RATE_PLAN_REF: arena.ratePlan.ratePlanRef,
    CHECK_IN: arena.stay.checkIn,
    CHECK_OUT: arena.stay.checkOut,
  }
}
