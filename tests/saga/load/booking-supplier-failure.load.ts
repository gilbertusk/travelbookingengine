import { defineOutageScenario } from './outage.js'

/**
 * Supplier mati di tengah beban normal. Lihat infra/k6/booking-supplier-failure.js.
 *
 * "Mati" lewat panel kendali mock-supplier, sesuai step doc: koneksi diterima
 * lalu diputus. Sejak Step 20 itu TIDAK PASTI — supplier mungkin sudah
 * mengerjakannya — jadi pemesanan yang sudah dibayar dan gagal dikonfirmasi
 * berakhir di NEEDS_REVIEW, bukan refund buta (US-05). Hasil itu yang
 * diharapkan di sini, dan dihitung terpisah dari M6 di laporan.
 *
 * Kontainer yang DIHENTIKAN sengaja tidak dipakai: mock-supplier menyimpan
 * pemesanannya di memori, dan kontainer yang dinyalakan ulang kehilangan
 * seluruhnya — pemeriksaan "pemesanan di supplier cocok dengan CONFIRMED"
 * lalu membandingkan dengan buku yang sudah dihapus. Jalur refund diukur
 * skenario `booking-supplier-refusal`, yang gagal dengan PASTI tanpa
 * mematikan kontainernya.
 */
defineOutageScenario({
  scenario: 'booking-supplier-failure',
  title: 'supplier mati di tengah beban: setiap pemesanan berakhir final',
  fail: async (system) => {
    await system.supplier.panelDown()
  },
  restore: async (system) => {
    await system.supplier.panelUp()
  },
})
