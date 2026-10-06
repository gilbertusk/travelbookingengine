import { inject } from 'vitest'

/**
 * Infrastruktur uji integrasi, dari global setup.
 *
 * Sejak Step 20 global setup MENYALAKAN Postgres, Redis, Kafka, dan RabbitMQ
 * sungguhan lewat Testcontainers (CONVENTIONS.md bagian 10), kecuali keempat
 * env `INTEGRATION_*` diisi — jalur cepat untuk mesin yang infranya sudah
 * menyala (`pnpm infra:up`). Tidak ada jalur ketiga: tanpa env DAN tanpa
 * Docker, global setup melempar dan uji GAGAL keras. Uji integrasi yang
 * diam-diam tidak berjalan adalah persis "hijau" yang dilarang NFR-19.
 */
export interface IntegrationInfra {
  readonly databaseUrl: string
  readonly redisUrl: string
  readonly kafkaBrokers: readonly string[]
  readonly rabbitmqUrl: string
}

declare module 'vitest' {
  export interface ProvidedContext {
    integration: IntegrationInfra
  }
}

export function integrationEnv(): { databaseUrl: string; redisUrl: string } {
  const { databaseUrl, redisUrl } = inject('integration')
  return { databaseUrl, redisUrl }
}

export function brokerEnv(): { kafkaBrokers: readonly string[]; rabbitmqUrl: string } {
  const { kafkaBrokers, rabbitmqUrl } = inject('integration')
  return { kafkaBrokers, rabbitmqUrl }
}

/**
 * Env `INTEGRATION_*`, bila KEEMPATNYA diisi. Sebagian saja dianggap salah
 * konfigurasi dan ditolak — separuh infrastruktur dari env dan separuh dari
 * kontainer adalah dua lingkungan yang berbeda dalam satu uji.
 */
export function infraFromEnv(env: NodeJS.ProcessEnv): IntegrationInfra | undefined {
  const values = [
    env.INTEGRATION_DATABASE_URL,
    env.INTEGRATION_REDIS_URL,
    env.INTEGRATION_KAFKA_BROKERS,
    env.INTEGRATION_RABBITMQ_URL,
  ]
  const [databaseUrl, redisUrl, kafka, rabbitmqUrl] = values
  if (values.every((value) => value === undefined)) return undefined
  if (
    databaseUrl === undefined ||
    redisUrl === undefined ||
    kafka === undefined ||
    rabbitmqUrl === undefined
  ) {
    throw new Error(
      'INTEGRATION_* diisi sebagian. Isi keempatnya (DATABASE_URL, REDIS_URL, KAFKA_BROKERS, RABBITMQ_URL), atau kosongkan semuanya supaya Testcontainers yang menyalakannya.',
    )
  }
  return { databaseUrl, redisUrl, kafkaBrokers: kafka.split(','), rabbitmqUrl }
}
