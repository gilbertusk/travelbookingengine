import { z } from 'zod'
import { ConfigError } from '../errors/app-error.js'

/**
 * Konfigurasi tervalidasi saat startup.
 *
 * CONVENTIONS.md bagian 12: env tidak sah berarti proses berhenti, bukan jalan
 * dengan nilai bawaan. Service yang menyala dengan konfigurasi separuh benar
 * gagal jauh kemudian, di tempat yang tidak ada hubungannya dengan penyebabnya.
 *
 * Pesan galat menyebut nama variabel dan apa yang diharapkan, tetapi TIDAK
 * PERNAH nilai yang diterima — variabel env seringkali berisi kredensial, dan
 * galat startup biasanya berakhir di log yang dibaca banyak orang.
 */

export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVICE_NAME: z.string().min(1),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
})

export type BaseEnv = z.infer<typeof baseEnvSchema>

export function createConfig<S extends z.ZodType>(
  schema: S,
  env: NodeJS.ProcessEnv = process.env,
): z.infer<S> {
  const result = schema.safeParse(env)

  if (result.success) {
    return result.data
  }

  throw new ConfigError(formatIssues(result.error), {
    variables: result.error.issues.map((issue) => issue.path.join('.')),
  })
}

function formatIssues(error: z.ZodError): string {
  const baris = error.issues.map((issue) => {
    const variable = issue.path.length > 0 ? issue.path.join('.') : '(akar)'
    return `  ${variable}: ${issue.message}`
  })

  return `Konfigurasi tidak sah. Perbaiki variabel berikut:\n${baris.join('\n')}`
}
