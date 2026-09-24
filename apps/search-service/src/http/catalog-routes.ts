import { NotFoundError, success, validate } from '@tbe/shared-kernel'
import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import { suggest } from '../application/autocomplete.js'
import { createPropertyFromUnmapped, mapToExistingProperty } from '../application/manual-mapping.js'
import type { CatalogDeps, CatalogSnapshot } from '../application/ports.js'

/**
 * Antarmuka katalog.
 *
 * Dua kelompok yang berbeda sifatnya:
 *
 *   Publik   — autocomplete dan halaman properti. Dilayani snapshot di memori.
 *   Operator — antrian properti belum terpetakan. Dilindungi peran operator
 *              di api-gateway, bukan di sini.
 */

const SUGGEST_MAX_LIMIT = 25

const suggestQuery = validate(
  z.object({
    q: z.string().max(120).default(''),
    limit: z.coerce.number().int().min(1).max(SUGGEST_MAX_LIMIT).optional(),
  }),
  'query',
)

const mapExistingBody = validate(
  z.object({
    supplierId: z.string().min(1).max(40),
    supplierPropertyId: z.string().min(1).max(200),
    propertyId: z.uuid(),
  }),
  'body',
)

const createPropertyBody = validate(
  z.object({
    supplierId: z.string().min(1).max(40),
    supplierPropertyId: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    city: z.string().min(1).max(120),
    countryCode: z.string().length(2),
    /**
     * Zona waktu wajib, bukan opsional dengan bawaan.
     *
     * Bawaan `Asia/Jakarta` akan benar untuk sebagian besar properti dan
     * salah diam-diam untuk properti di Bali dan di luar negeri — lalu Step 25
     * menghitung tenggat pembatalan dengan zona waktu yang keliru, dan
     * selisihnya berarti pengembalian dana yang seharusnya tidak terjadi.
     */
    timezone: z.string().min(1).max(64),
    address: z.string().max(400).default(''),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    starRating: z.number().int().min(0).max(5).default(0),
  }),
  'body',
)

export interface CatalogRouterOptions {
  readonly deps: CatalogDeps
  /** Snapshot yang sedang dipegang proses. Lihat composition/snapshot-holder.ts. */
  readonly snapshot: () => CatalogSnapshot | undefined
  readonly newId: () => string
  /** Dipanggil setelah pemetaan berubah, supaya salinan di Redis dibuang. */
  readonly onCatalogChanged: () => Promise<void>
}

export function createCatalogRouter(options: CatalogRouterOptions): Router {
  const router = Router()

  router.get('/catalog/suggest', suggestQuery, suggestHandler(options.deps))
  router.get('/catalog/properties/:slug', propertyHandler(options))

  router.get('/internal/catalog/unmapped', unmappedHandler(options.deps))
  router.post('/internal/catalog/unmapped/map', mapExistingBody, mapExistingHandler(options))
  router.post('/internal/catalog/unmapped/create', createPropertyBody, createHandler(options))

  return router
}

function suggestHandler(deps: CatalogDeps): RequestHandler {
  return (_req, res, next) => {
    const { q, limit } = suggestQuery.value(res)

    void suggest(deps, { query: q, ...(limit === undefined ? {} : { limit }) }).then((result) => {
      res.json(success(result))
    }, next)
  }
}

/**
 * Halaman properti menurut slug.
 *
 * Dilayani dari snapshot di memori, bukan dari basis data. Halaman ini
 * dirender di sisi server untuk mesin pencari (PRD Bab 12), yang berarti
 * setiap perayapan menjadi satu permintaan ke sini.
 */
function propertyHandler(options: CatalogRouterOptions): RequestHandler {
  return (req, res, next) => {
    const slug = String(req.params.slug)
    const snapshot = options.snapshot()

    if (snapshot === undefined) {
      next(new NotFoundError('katalog belum termuat'))
      return
    }

    const property = snapshot.propertyBySlug(slug)
    if (property === undefined) {
      next(new NotFoundError(`properti ${slug} tidak ditemukan`))
      return
    }

    res.json(success(property))
  }
}

function unmappedHandler(deps: CatalogDeps): RequestHandler {
  return (req, res, next) => {
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200)

    void deps.unmapped.pending(limit).then((entries) => {
      res.json(success(entries))
    }, next)
  }
}

function mapExistingHandler(options: CatalogRouterOptions): RequestHandler {
  return (req, res, next) => {
    const body = mapExistingBody.value(res)
    const operator = operatorOf(req.headers['x-tbe-user-id'])

    void mapToExistingProperty(options.deps, { ...body, operator })
      .then(async (result) => {
        if (!result.ok) {
          next(new NotFoundError(reasonText(result.reason)))
          return
        }

        await options.onCatalogChanged()
        res.json(success(result))
      })
      .catch(next)
  }
}

function createHandler(options: CatalogRouterOptions): RequestHandler {
  return (req, res, next) => {
    const body = createPropertyBody.value(res)
    const operator = operatorOf(req.headers['x-tbe-user-id'])
    const snapshot = options.snapshot()

    void createPropertyFromUnmapped(options.deps, {
      ...body,
      operator,
      newId: options.newId,
      // Slug yang sudah terpakai diambil dari snapshot, bukan dari kueri
      // tersendiri. Snapshot sudah memuat seluruh katalog di memori; satu
      // kueri lagi untuk hal yang sudah ada di tangan adalah kueri yang
      // tidak perlu.
      takenSlugs: takenSlugs(snapshot),
    })
      .then(async (result) => {
        if (!result.ok) {
          next(new NotFoundError(reasonText(result.reason)))
          return
        }

        await options.onCatalogChanged()
        res.status(201).json(success(result))
      })
      .catch(next)
  }
}

function takenSlugs(snapshot: CatalogSnapshot | undefined): ReadonlySet<string> {
  return snapshot?.slugs() ?? new Set<string>()
}

function operatorOf(header: string | readonly string[] | undefined): string {
  // Header identitas dipasang api-gateway dan tidak pernah berasal dari klien
  // — lihat stripForgedHeaders di sana. Tanpa header, ini bukan permintaan
  // operator dan pemetaannya dicatat sebagai tidak diketahui.
  const value = typeof header === 'string' ? header : header?.[0]

  return value !== undefined && value.length > 0 ? value : 'unknown'
}

function reasonText(reason: 'unmapped_not_found' | 'property_not_found'): string {
  return reason === 'unmapped_not_found'
    ? 'properti belum terpetakan itu tidak ada di antrian'
    : 'properti tujuan tidak ditemukan'
}
