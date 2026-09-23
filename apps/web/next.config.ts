import type { NextConfig } from 'next'

/**
 * Header keamanan diatur di sini, bukan di gateway, karena inilah yang
 * menyajikan HTML ke peramban. Gateway hanya menyajikan JSON, dan header
 * seperti X-Frame-Options tidak berarti apa-apa pada respons JSON.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
]

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Next menuntut nilai balik berupa Promise, tetapi tidak ada yang ditunggu
  // di sini — daftarnya statis.
  headers: () => Promise.resolve([{ source: '/:path*', headers: securityHeaders }]),
}

export default nextConfig
