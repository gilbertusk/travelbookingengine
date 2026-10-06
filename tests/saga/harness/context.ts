import { inject } from 'vitest'

/**
 * Apa yang dibagikan global setup kepada setiap berkas uji.
 *
 * Hanya ALAMAT, bukan objek kontainer: global setup berjalan di proses utama
 * Vitest, berkas uji di proses pekerja, dan yang dapat melintasi batas itu
 * hanya data yang dapat diserialkan.
 */
export interface InfraInfo {
  /** URL ke basis data tertentu di server Postgres uji. */
  readonly postgresUrlTemplate: string
  readonly redisUrl: string
  readonly kafkaBrokers: readonly string[]
  readonly rabbitmqUrl: string
  readonly mockSupplier: {
    readonly url: string
    /** Id kontainer Docker, supaya uji dapat MEMATIKAN supplier sungguhan. */
    readonly containerId: string
    readonly holdTtlMs: number
  }
}

declare module 'vitest' {
  export interface ProvidedContext {
    infra: InfraInfo
  }
}

export const DATABASES = ['booking', 'payment', 'supplier', 'pricing'] as const
export type ServiceDatabase = (typeof DATABASES)[number]

export function databaseUrl(template: string, database: ServiceDatabase): string {
  return template.replace('{db}', database)
}

export function infra(): InfraInfo {
  return inject('infra')
}
