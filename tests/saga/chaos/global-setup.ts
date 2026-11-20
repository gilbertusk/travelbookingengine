import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'
import type { TestProject } from 'vitest/node'
import infraSetup from '../harness/global-setup.js'

/**
 * Infrastruktur uji chaos (Step 28): seluruh infrastruktur uji saga, ditambah
 * Jaeger. Trace satu pemulihan lengkap adalah bagian bukti yang diminta step
 * ini, dan trace yang tidak dikirim ke mana pun tidak dapat dilampirkan.
 *
 * Jaeger all-in-one versi 1: satu kontainer yang menerima OTLP/HTTP dan
 * melayani API kueri, tanpa penyimpanan luar. Versi tag tetap, seperti citra
 * lain di @tbe/testing-infra.
 */

const JAEGER_IMAGE = 'jaegertracing/all-in-one:1.62.0'

export interface JaegerInfo {
  /** Titik OTLP/HTTP untuk trace: nilai OTEL_EXPORTER_OTLP_ENDPOINT service. */
  readonly otlpTracesUrl: string
  /** API kueri Jaeger, untuk mengunduh trace sebagai JSON. */
  readonly queryUrl: string
}

declare module 'vitest' {
  export interface ProvidedContext {
    jaeger: JaegerInfo
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const teardownInfra = await infraSetup(project)
  let jaeger: StartedTestContainer | undefined

  try {
    jaeger = await new GenericContainer(JAEGER_IMAGE)
      .withEnvironment({ COLLECTOR_OTLP_ENABLED: 'true' })
      .withExposedPorts(4318, 16686)
      .withWaitStrategy(Wait.forHttp('/', 16686))
      .start()
    project.provide('jaeger', {
      otlpTracesUrl: `http://127.0.0.1:${String(jaeger.getMappedPort(4318))}/v1/traces`,
      queryUrl: `http://127.0.0.1:${String(jaeger.getMappedPort(16686))}`,
    })
  } catch (error) {
    await teardownInfra()
    throw error
  }

  const started = jaeger
  return async () => {
    await started.stop()
    await teardownInfra()
  }
}
