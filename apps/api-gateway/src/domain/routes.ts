/**
 * Tabel rute sebagai data.
 *
 * Satu daftar, bukan pemanggilan `app.use` yang tersebar. Yang diuntungkan
 * bukan kerapian: daftar ini dapat diperiksa pengujian, dicetak ke README,
 * dan ditinjau sebagai satu kesatuan. Rute yang lupa ditandai butuh
 * autentikasi akan terlihat saat membaca sepuluh baris, bukan saat menelusuri
 * sepuluh berkas.
 *
 * Gateway TIDAK memuat satu pun aturan bisnis. Kalau sebuah keputusan
 * membutuhkan pengetahuan tentang pemesanan, tempatnya bukan di sini.
 */

export type ServiceName =
  | 'auth'
  | 'search'
  | 'booking'
  | 'payment'
  | 'voucher'
  | 'pricing'
  | 'analytics'
  | 'supplier'
  | 'mock-supplier'

/** Peran yang dapat dituntut sebuah rute. Pelanggan tidak perlu disebut: cukup `requiresAuth`. */
export type RequiredRole = 'operator'

export type RateLimitClass = 'public' | 'authenticated' | 'search' | 'sensitive'

export interface RouteDefinition {
  /** Awalan path publik. Pencocokan berbasis awalan, bukan pola. */
  readonly prefix: string
  readonly service: ServiceName
  readonly requiresAuth: boolean
  /**
   * Peran yang dituntut (Step 27). Diperiksa di gateway SETELAH token
   * diverifikasi, dan sekali lagi di service lewat `requireOperator` —
   * lihat shared-kernel/src/http/operator.ts.
   */
  readonly requiredRole?: RequiredRole
  readonly rateLimit: RateLimitClass
  /** Server-Sent Events: tidak boleh di-buffer, dan batas waktunya panjang. */
  readonly streaming?: boolean
  readonly timeoutMs: number
  readonly methods?: readonly string[]
}

/** Batas waktu berbeda per jenis rute, bukan satu angka untuk semuanya. */
const TIMEOUT = {
  /** Pencarian punya anggaran waktu sendiri di search-service (Step 13). */
  search: 3_000,
  standard: 10_000,
  /** Alur pembayaran menunggu penyedia luar. */
  payment: 20_000,
  /** SSE dibiarkan hidup; penutupannya ditentukan klien. */
  streaming: 300_000,
} as const

export const ROUTES: readonly RouteDefinition[] = [
  {
    prefix: '/auth/login',
    service: 'auth',
    requiresAuth: false,
    rateLimit: 'sensitive',
    timeoutMs: TIMEOUT.standard,
    methods: ['POST'],
  },
  {
    prefix: '/auth/register',
    service: 'auth',
    requiresAuth: false,
    rateLimit: 'sensitive',
    timeoutMs: TIMEOUT.standard,
    methods: ['POST'],
  },
  {
    prefix: '/auth/refresh',
    service: 'auth',
    requiresAuth: false,
    rateLimit: 'sensitive',
    timeoutMs: TIMEOUT.standard,
    methods: ['POST'],
  },
  {
    prefix: '/auth',
    service: 'auth',
    requiresAuth: false,
    rateLimit: 'public',
    timeoutMs: TIMEOUT.standard,
  },
  {
    prefix: '/search',
    service: 'search',
    requiresAuth: false,
    rateLimit: 'search',
    timeoutMs: TIMEOUT.search,
  },
  {
    prefix: '/properties',
    service: 'search',
    requiresAuth: false,
    rateLimit: 'search',
    timeoutMs: TIMEOUT.search,
  },
  {
    // Autocomplete dan halaman properti dari katalog (Step 12b). Dilayani
    // snapshot di memori search-service, jadi anggaran waktunya jauh lebih
    // longgar daripada yang dibutuhkan — tetapi tetap dibatasi seperti
    // pencarian, karena kotak pencarian memanggilnya pada setiap ketikan.
    prefix: '/catalog',
    service: 'search',
    requiresAuth: false,
    rateLimit: 'search',
    timeoutMs: TIMEOUT.search,
  },
  {
    // Harus berada SEBELUM /bookings: pencocokan mengambil awalan terpanjang,
    // tetapi urutan tetap ditulis eksplisit agar terbaca manusia.
    prefix: '/bookings/stream',
    service: 'booking',
    requiresAuth: true,
    rateLimit: 'authenticated',
    streaming: true,
    timeoutMs: TIMEOUT.streaming,
    methods: ['GET'],
  },
  {
    prefix: '/bookings',
    service: 'booking',
    requiresAuth: true,
    rateLimit: 'authenticated',
    timeoutMs: TIMEOUT.standard,
  },
  {
    prefix: '/payments/webhook',
    service: 'payment',
    // Webhook penyedia pembayaran tidak membawa token pengguna. Keasliannya
    // diverifikasi lewat tanda tangan di payment-service (Step 18), bukan di
    // sini — gateway tidak boleh memegang kunci penyedia.
    requiresAuth: false,
    rateLimit: 'public',
    timeoutMs: TIMEOUT.payment,
    methods: ['POST'],
  },
  {
    prefix: '/payments',
    service: 'payment',
    requiresAuth: true,
    rateLimit: 'authenticated',
    timeoutMs: TIMEOUT.payment,
  },
  {
    prefix: '/vouchers',
    service: 'voucher',
    requiresAuth: true,
    rateLimit: 'authenticated',
    timeoutMs: TIMEOUT.standard,
  },
  ...opsRoutes(),
]

/**
 * Rute panel operator (Step 27, FR-29 sampai FR-32).
 *
 * Satu awalan `/ops` untuk seluruhnya, dan setiap service hulu memasang
 * routernya di bawah awalan yang SAMA. Gateway meneruskan path apa adanya,
 * jadi service melihat `/ops/...` dan memasang `requireOperator` di sana.
 * Alternatif yang ditolak: menulis ulang `/ops/suppliers` menjadi
 * `/internal/suppliers`. Itu membuat rute internal — yang sengaja tanpa
 * pemeriksaan identitas karena pemanggilnya service — dapat dicapai dari luar
 * cukup dengan satu kesalahan tabel.
 *
 * Kelas batas laju `authenticated`: operator adalah pengguna terautentikasi
 * yang sedikit jumlahnya; kelas tersendiri tidak membeli apa pun.
 */
function opsRoutes(): RouteDefinition[] {
  const targets: readonly (readonly [string, ServiceName])[] = [
    ['/ops/analytics', 'analytics'],
    ['/ops/suppliers', 'supplier'],
    ['/ops/pricing', 'pricing'],
    ['/ops/bookings', 'booking'],
    ['/ops/payments', 'payment'],
    ['/ops/mock-supplier', 'mock-supplier'],
  ]

  return targets.map(([prefix, service]) => ({
    prefix,
    service,
    requiresAuth: true,
    requiredRole: 'operator',
    rateLimit: 'authenticated',
    timeoutMs: TIMEOUT.standard,
  }))
}

export const ALLOWED_METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'] as const

export function isAllowedMethod(method: string): boolean {
  return (ALLOWED_METHODS as readonly string[]).includes(method.toUpperCase())
}

/**
 * Mencocokkan permintaan dengan rute. Awalan terpanjang menang.
 *
 * Pencocokan berbasis awalan terpanjang, bukan urutan daftar. Bergantung pada
 * urutan berarti menyisipkan satu rute baru di tempat yang salah diam-diam
 * mengubah perilaku rute lain.
 */
export function matchRoute(method: string, path: string): RouteDefinition | undefined {
  let best: RouteDefinition | undefined

  for (const route of ROUTES) {
    if (!pathMatches(path, route.prefix)) continue
    if (route.methods !== undefined && !route.methods.includes(method.toUpperCase())) continue
    if (best === undefined || route.prefix.length > best.prefix.length) best = route
  }

  return best
}

function pathMatches(path: string, prefix: string): boolean {
  if (!path.startsWith(prefix)) return false

  // '/searching' tidak boleh cocok dengan awalan '/search'.
  const next = path.charAt(prefix.length)
  return next === '' || next === '/' || next === '?'
}
