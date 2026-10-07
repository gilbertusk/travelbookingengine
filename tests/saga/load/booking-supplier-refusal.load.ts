import { defineOutageScenario } from './outage.js'

/**
 * Supplier MENOLAK di tengah beban normal: jalur kompensasi lengkap (US-03, M6).
 *
 * Beban yang sama dengan `booking-supplier-failure`, tetapi supplier menjawab
 * 503 untuk setiap permintaan. Jawaban 503 adalah kepastian bahwa
 * permintaannya tidak dikerjakan, jadi pemesanan yang sudah dibayar dan gagal
 * dikonfirmasi TIDAK diserahkan ke manusia: perintah konfirmasinya dicoba
 * sepanjang jenjang retry RabbitMQ yang sungguhan (5 s, 30 s, 2 m), lalu saga
 * mengembalikan dana dan pemesanannya berakhir REFUNDED.
 *
 * Skenario ini ada karena `booking-supplier-failure` tidak pernah menghasilkan
 * satu refund pun: di sana kegagalannya tidak pasti, dan refund buta atas
 * kegagalan yang tidak pasti justru yang dilarang US-05. Tanpa skenario ini,
 * "waktu dari kegagalan sampai refund selesai" tidak pernah terukur di bawah
 * beban, dan M6 hanya terbukti lewat cabang peninjauannya.
 *
 * Kontainernya TIDAK dihentikan. Mock-supplier tetap hidup dan tetap memegang
 * buku pemesanannya, sehingga pemeriksaan "pemesanan di supplier cocok dengan
 * CONFIRMED" tetap berarti — pemesanan yang direfund tidak boleh muncul di
 * sana.
 */
defineOutageScenario({
  scenario: 'booking-supplier-refusal',
  title: 'supplier menolak di tengah beban: yang sudah dibayar direfund',
  fail: async (system) => {
    await system.supplier.panelRefuse()
  },
  restore: async (system) => {
    // `reset` mengembalikan peluang kegagalan ke nol; `panelUp` tidak.
    await system.supplier.reset()
  },
})
