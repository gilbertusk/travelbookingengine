import type { Express } from 'express'
import type { Logger } from '@tbe/shared-kernel'
import {
  createHttpServer,
  createMetrics,
  finalizeHttpServer,
  type Metrics,
} from '@tbe/shared-kernel'
import { createChaosRegistry, type ChaosRegistry } from '../application/chaos.js'
import { createFaultScript } from '../application/fault-script.js'
import type { OperationDeps } from '../application/ports.js'
import { DEFAULT_HOLD_TTL_MS } from '../domain/booking.js'
import { buildCatalog } from '../domain/catalog.js'
import { SUPPLIER_CODES, type SupplierCode } from '../domain/supplier.js'
import { createCatalogReader } from '../infrastructure/catalog-reader.js'
import { createMemoryStore } from '../infrastructure/memory-store.js'
import { createRefIndex } from '../infrastructure/ref-index.js'
import { newRef, systemClock, systemRandom } from '../infrastructure/runtime.js'
import { createAdminRouter } from '../http/admin.js'
import { createCatalogRouter } from '../http/catalog.js'
import { createChaosMiddleware } from '../http/chaos-middleware.js'
import type { SupplierContext } from '../http/context.js'
import { createLunaRouter } from '../http/suppliers/luna.js'
import { createNovaRouter } from '../http/suppliers/nova.js'
import { createOrbitRouter } from '../http/suppliers/orbit.js'
import { createSkyRouter } from '../http/suppliers/sky.js'
import { createZephRouter } from '../http/suppliers/zeph.js'

export interface MockSupplierApp {
  readonly app: Express
  readonly context: SupplierContext
  readonly metrics: Metrics
}

export interface BuildAppOptions {
  readonly logger: Logger
  /** Melewati seluruh latensi tiruan; dipakai pengujian agar tetap cepat. */
  readonly instant?: boolean | undefined
  readonly random?: (() => number) | undefined
  readonly now?: (() => number) | undefined
  /** Umur hold bawaan; tanpa nilai, 15 menit seperti supplier sungguhan. */
  readonly holdTtlMs?: number | undefined
}

const ROUTERS: Readonly<
  Record<SupplierCode, (context: SupplierContext) => ReturnType<typeof createSkyRouter>>
> = {
  SKY: createSkyRouter,
  NOVA: createNovaRouter,
  ORBIT: createOrbitRouter,
  LUNA: createLunaRouter,
  ZEPH: createZephRouter,
}

export function buildMockSupplierApp(options: BuildAppOptions): MockSupplierApp {
  const catalog = createCatalogReader(buildCatalog())
  const store = createMemoryStore()
  const chaos: ChaosRegistry = createChaosRegistry()
  const script = createFaultScript()
  const random = options.random ?? systemRandom

  const deps: OperationDeps = {
    catalog,
    store,
    clock: options.now === undefined ? systemClock : { now: options.now },
    random,
    newRef,
    holdTtlMs: options.holdTtlMs ?? DEFAULT_HOLD_TTL_MS,
  }

  const context: SupplierContext = {
    deps,
    chaos,
    refs: createRefIndex(catalog.catalog),
    catalog,
  }

  // Registry metrik diteruskan ke pabrik server, yang memasang /metrics
  // sendiri. Endpoint yang harus didaftarkan manual di setiap service adalah
  // endpoint yang akan terlupa di salah satunya.
  const metrics = createMetrics({ serviceName: 'mock-supplier' })
  const app = createHttpServer({ logger: options.logger, metrics })

  app.get('/health/live', (_req, res) => {
    res.json({ data: { status: 'alive' }, error: null })
  })

  app.use('/admin', createAdminRouter({ chaos, script, deps, refs: context.refs }))
  app.use('/admin', createCatalogRouter(catalog))

  for (const code of SUPPLIER_CODES) {
    const path = `/${code.toLowerCase()}`
    app.use(path, createChaosMiddleware({ code, chaos, random, instant: options.instant, script }))
    app.use(path, ROUTERS[code](context))
  }

  finalizeHttpServer(app, options.logger)

  return { app, context, metrics }
}
