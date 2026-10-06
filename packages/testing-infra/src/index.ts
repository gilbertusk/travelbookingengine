/**
 * @tbe/testing-infra — infrastruktur sungguhan untuk uji integrasi.
 *
 * Dipakai uji integrasi booking-service dan rangkaian uji saga lintas service
 * (Step 20). Satu tempat untuk citra dan konfigurasinya, supaya kedua rangkaian
 * menguji terhadap broker yang sama dan tidak ada yang tertinggal saat versi
 * infrastruktur dinaikkan.
 */

export {
  IMAGES,
  freePort,
  startKafka,
  startPostgres,
  startRabbit,
  startRedis,
  type Started,
  type StartedKafka,
  type StartedPostgres,
  type StartedRabbit,
  type StartedRedis,
} from './containers.js'

export { createDatabases, deployMigrations, runSeed } from './database.js'

export { buildImage } from './image.js'
