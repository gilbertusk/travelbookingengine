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

/**
 * Broker sungguhan untuk uji saga Step 19. Sama dengan di atas: tanpa nilai
 * bawaan, dan GAGAL keras bila tidak ada. Uji jalur kompensasi yang diam-diam
 * tidak berjalan karena Kafka tidak tersedia adalah persis "hijau" yang
 * dilarang NFR-19.
 */
export function brokerEnv(): { kafkaBrokers: readonly string[]; rabbitmqUrl: string } {
  const kafka = process.env.INTEGRATION_KAFKA_BROKERS
  const rabbitmqUrl = process.env.INTEGRATION_RABBITMQ_URL

  if (kafka === undefined || rabbitmqUrl === undefined) {
    throw new Error(
      'INTEGRATION_KAFKA_BROKERS dan INTEGRATION_RABBITMQ_URL wajib diisi. Uji integrasi tidak dilewati diam-diam.',
    )
  }

  return { kafkaBrokers: kafka.split(','), rabbitmqUrl }
}
