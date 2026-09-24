/**
 * Kondisi supplier untuk skenario terdegradasi.
 *
 * Inilah yang membuktikan hipotesis PRD Bab 6, dan bunyinya sangat spesifik:
 * satu supplier sengaja dibuat merespons 3 detik, satu supplier lain
 * dimatikan, dan pencarian tetap menjawab di bawah 800ms pada p95.
 *
 * Angka-angkanya karena itu tidak boleh dikarang di sini — ketiganya dikutip
 * langsung dari hipotesisnya, dan menurunkannya berarti membuktikan hipotesis
 * yang lain.
 *
 * Yang dipilih untuk dilambatkan adalah LUNA, yang memang sudah paling lambat
 * pada profilnya (2,4–3,2 detik). Yang dimatikan adalah ZEPH, yang sudah
 * paling sering gagal (15%). Memilih supplier tercepat untuk dirusak akan
 * menghasilkan uji yang lebih mudah dilewati daripada kenyataan.
 */

export const SLOW_SUPPLIER = 'luna'
export const DOWN_SUPPLIER = 'zeph'

/** Tepat 3 detik, seperti yang tertulis di hipotesis. */
export const SLOW_LATENCY_MS = 3_000

export const DEGRADED_PLAN = [
  {
    path: `/admin/${SLOW_SUPPLIER}/latency`,
    body: { min: SLOW_LATENCY_MS, max: SLOW_LATENCY_MS },
    what: `${SLOW_SUPPLIER.toUpperCase()} dilambatkan ke ${String(SLOW_LATENCY_MS)}ms`,
  },
  {
    path: `/admin/${DOWN_SUPPLIER}/down`,
    body: {},
    what: `${DOWN_SUPPLIER.toUpperCase()} dimatikan`,
  },
]

/**
 * Mengembalikan seluruh supplier ke perilaku bawaan profilnya.
 *
 * `/up` mengembalikan ke bawaan, bukan sekadar mematikan flag `down` —
 * suntikan yang tertinggal dari skenario sebelumnya adalah penyebab paling
 * umum uji berikutnya gagal tanpa sebab yang jelas.
 *
 * Dipanggil SEBELUM dan SESUDAH setiap skenario. Yang sebelum itu penting:
 * skenario yang dijalankan setelah skenario terdegradasi yang tertinggal
 * akan melaporkan angka baseline yang jauh lebih buruk, dan yang disalahkan
 * adalah perubahan kode terakhir.
 */
export const RESET_PLAN = [{ path: '/admin/reset', body: {}, what: 'seluruh supplier dinormalkan' }]
