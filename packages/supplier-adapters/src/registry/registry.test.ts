import { describe, expect, test } from 'vitest'
import { SUPPLIER_CODES } from '../canonical/model.js'
import { createSupplierRegistry, mockSupplierRegistryConfig } from './registry.js'

describe('registri adapter', () => {
  test('menyediakan adapter untuk kelima supplier', () => {
    const registry = createSupplierRegistry(mockSupplierRegistryConfig('http://localhost:4000'))

    for (const code of SUPPLIER_CODES) {
      expect(registry.get(code).supplier).toBe(code)
    }
  })

  test('semuanya memenuhi antarmuka yang sama', () => {
    // Inilah seluruh alasan paket ini ada: di balik antarmuka ini, SOAP
    // dengan tanggal DD/MM/YYYY dan JSON dengan epoch detik menjadi sama.
    const registry = createSupplierRegistry(mockSupplierRegistryConfig('http://localhost:4000'))

    for (const adapter of registry.all()) {
      for (const method of [
        'search',
        'priceCheck',
        'hold',
        'book',
        'cancel',
        'getBooking',
        'findBookingByIdempotencyKey',
      ] as const) {
        expect(typeof adapter[method]).toBe('function')
      }
    }
  })

  test('all() mengembalikan kelimanya untuk fan-out pencarian', () => {
    const registry = createSupplierRegistry(mockSupplierRegistryConfig('http://localhost:4000'))

    expect(
      registry
        .all()
        .map((adapter) => adapter.supplier)
        .sort(),
    ).toEqual([...SUPPLIER_CODES].sort())
  })

  test('alamat supplier datang dari konfigurasi, tidak tertanam', () => {
    // Satu alamat yang tertulis di dalam kode adalah alamat yang akan ikut
    // terbawa ke produksi.
    const config = mockSupplierRegistryConfig('https://staging.example.test')

    expect(config.SKY.baseUrl).toBe('https://staging.example.test/sky')
    expect(config.ORBIT.baseUrl).toBe('https://staging.example.test/orbit')
  })

  test('LUNA diberi batas waktu lebih longgar karena memang lambat', () => {
    // p50 LUNA sekitar 2,8 detik. Memaksanya ke batas waktu SKY berarti
    // membuang seluruh hasilnya setiap kali, dan itu terlihat seperti
    // supplier mati padahal ia hanya lambat.
    const config = mockSupplierRegistryConfig('http://localhost:4000')

    expect(config.LUNA.timeouts?.search).toBeGreaterThan(3_000)
    expect(config.SKY.timeouts).toBeUndefined()
  })
})
