import type { KafkaProducerPort } from '@tbe/messaging'
import type { Logger } from '@tbe/shared-kernel'

/**
 * Pengganti produsen dead letter untuk analitik: MENCATAT, tidak mengirim.
 *
 * Pembungkus consumer @tbe/messaging mengirim pesan yang tidak sesuai kontrak
 * ke tbe.dead-letter.v1. Untuk service pemilik alur itu benar. Untuk
 * analitik tidak: pesan cacat yang sama sudah dikirim ke dead letter oleh
 * consumer pemiliknya, dan analitik yang ikut mengirim akan menggandakan
 * setiap entri dead letter — mengganggu persis tempat operator mencari
 * penyebab insiden. Analitik tidak menulis ke Kafka sama sekali; itulah arti
 * "tidak mengganggu alur utama" yang diuji di tests/integration.
 */
export function deadLetterObserver(
  logger: Logger,
  onObserved: (topic: string) => void = () => undefined,
): KafkaProducerPort {
  return {
    async send(topic, records) {
      onObserved(topic)
      logger.warn(
        { topic, count: records.length, origin: records[0]?.headers['x-origin-topic'] },
        'peristiwa cacat dilewati analitik; dead letter milik consumer pemiliknya',
      )
      await Promise.resolve()
    },
  }
}
