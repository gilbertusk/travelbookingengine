import { inject } from 'vitest'

/** Infrastruktur uji integrasi analitik, dari global setup. */
export interface AnalyticsInfra {
  readonly databaseUrl: string
  readonly kafkaBrokers: readonly string[]
}

declare module 'vitest' {
  export interface ProvidedContext {
    analytics: AnalyticsInfra
  }
}

export function analyticsInfra(): AnalyticsInfra {
  return inject('analytics')
}

/**
 * Keduanya atau tidak sama sekali. Sebagian saja ditolak — Postgres dari env
 * dan Kafka dari kontainer adalah dua lingkungan dalam satu uji.
 */
export function infraFromEnv(env: NodeJS.ProcessEnv): AnalyticsInfra | undefined {
  const databaseUrl = env.INTEGRATION_DATABASE_URL
  const brokers = env.INTEGRATION_KAFKA_BROKERS
  if (databaseUrl === undefined && brokers === undefined) return undefined
  if (databaseUrl === undefined || brokers === undefined) {
    throw new Error(
      'INTEGRATION_* diisi sebagian. Isi INTEGRATION_DATABASE_URL DAN INTEGRATION_KAFKA_BROKERS, atau kosongkan keduanya supaya Testcontainers yang menyalakannya.',
    )
  }
  return { databaseUrl, kafkaBrokers: brokers.split(',') }
}
