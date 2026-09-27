/**
 * Infrastruktur uji integrasi. Tidak ada nilai bawaan: tanpa Redis dan
 * Postgres sungguhan, uji ini tidak punya apa pun untuk dibuktikan.
 */
export function integrationEnv(): { databaseUrl: string; redisUrl: string } {
  const databaseUrl = process.env.INTEGRATION_DATABASE_URL
  const redisUrl = process.env.INTEGRATION_REDIS_URL

  if (databaseUrl === undefined || redisUrl === undefined) {
    throw new Error(
      'INTEGRATION_DATABASE_URL dan INTEGRATION_REDIS_URL wajib diisi. Uji integrasi tidak dilewati diam-diam.',
    )
  }

  return { databaseUrl, redisUrl }
}
