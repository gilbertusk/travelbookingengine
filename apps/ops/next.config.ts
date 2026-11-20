import type { NextConfig } from 'next'

/**
 * Panel operator (Step 27, keputusan Q6).
 *
 * Aplikasi TERPISAH dari apps/web, dan pemisahan itu adalah batas
 * keamanannya: tidak ada satu baris kode operator pun yang dapat ikut
 * terkirim ke bundel publik, karena bundel publik dibangun dari aplikasi lain.
 * Pemeriksaan peran di gateway dan di service tetap berlaku; yang ditambahkan
 * pemisahan ini adalah bahwa penyerang tidak bisa membaca bentuk API operator
 * dari JavaScript yang dikirim ke pengguna.
 *
 * Header keamanan lebih ketat dari apps/web: panel ini tidak boleh dibingkai,
 * tidak diindeks, dan tidak mengirim referrer ke mana pun.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
]

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@tbe/ui'],
  headers: () => Promise.resolve([{ source: '/:path*', headers: securityHeaders }]),
}

export default nextConfig
