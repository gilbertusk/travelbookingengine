import { AppError, NotFoundError, success, validate } from '@tbe/shared-kernel'
import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import { search, type SearchResponse } from '../application/search.js'
import type { DeadlineFactory } from '../application/fan-out.js'
import type { SightingBuffer } from '../application/resolve-properties.js'
import {
  MAX_GUESTS,
  SORT_ORDERS,
  validateCriteria,
  type CriteriaProblem,
  type SearchCriteria,
} from '../domain/criteria.js'
import type { CatalogSnapshot, SearchDeps } from '../application/ports.js'

/**
 * Antarmuka pencarian.
 *
 * Validasi kriterianya ketat dengan sengaja. Setiap permintaan yang lolos
 * memicu fan-out ke lima supplier; permintaan yang keliru — tanggal lampau,
 * menginap lima tahun, seratus tamu — menghabiskan anggaran lima supplier
 * untuk jawaban yang tidak ada seorang pun memesannya.
 */

/**
 * Bendera boolean dari query string.
 *
 * TIDAK memakai `z.coerce.boolean()`: `Boolean('false')` bernilai `true`,
 * jadi `?refundableOnly=false` akan menyalakan penyaringnya. Kekeliruan itu
 * tidak menggagalkan apa pun — ia hanya menyaring hasil yang seharusnya
 * muncul, dan yang mengeluhkannya adalah pengguna yang tidak menemukan
 * hotelnya.
 */
const booleanFlag = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((value) => value === 'true' || value === '1')

const searchQuery = validate(
  z.object({
    city: z.string().min(2).max(120),
    checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'bukan tanggal kalender'),
    checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'bukan tanggal kalender'),
    guests: z.coerce.number().int().positive().max(MAX_GUESTS).default(2),
    sort: z.enum(SORT_ORDERS).default('relevance'),
    minStarRating: z.coerce.number().int().min(0).max(5).optional(),
    maxTotalMinor: z.coerce.number().int().positive().optional(),
    amenities: z
      .string()
      .optional()
      .transform((value) =>
        value === undefined
          ? []
          : value
              .split(',')
              .filter((item) => item.length > 0)
              .slice(0, 20),
      ),
    refundableOnly: booleanFlag,
    breakfastIncluded: booleanFlag,
  }),
  'query',
)

const invalidateBody = validate(z.object({ city: z.string().min(2).max(120) }), 'body')

export interface SearchRouterOptions {
  readonly deps: SearchDeps
  readonly snapshot: () => CatalogSnapshot | undefined
  readonly deadline: DeadlineFactory
  readonly sightings: SightingBuffer
  readonly onLateError: (supplier: string, error: unknown) => void
}

export function createSearchRouter(options: SearchRouterOptions): Router {
  const router = Router()

  router.get('/search', searchQuery, searchHandler(options))
  router.get('/search/properties/:ref', searchQuery, detailHandler(options))
  router.post('/internal/search/invalidate', invalidateBody, invalidateHandler(options))

  return router
}

function searchHandler(options: SearchRouterOptions): RequestHandler {
  return (_req, res, next) => {
    const criteria: SearchCriteria = searchQuery.value(res)

    const problem = validateCriteria(criteria, options.deps.settings.today())
    if (problem !== undefined) {
      next(criteriaError(problem))
      return
    }

    void runSearch(options, criteria).then((response) => {
      // Metadata ikut di dalam `data`, bukan di `meta` amplop — `meta` di
      // amplop khusus paginasi, dan memaksanya membawa hal lain akan
      // membuatnya berarti berbeda-beda di tiap service.
      res.json(success(response))
    }, next)
  }
}

/**
 * Seluruh tawaran untuk satu properti (FR-10).
 *
 * Memakai pencarian yang sama lalu memilih satu properti, bukan kueri
 * tersendiri ke supplier. Alasannya: harga hanya bermakna untuk rentang
 * tanggal tertentu, jadi halaman detail TETAP membutuhkan kriteria yang sama
 * — dan kalau kriterianya sama, jawabannya sudah ada di cache dan tidak ada
 * satu pun panggilan supplier baru yang perlu terjadi.
 */
function detailHandler(options: SearchRouterOptions): RequestHandler {
  return (req, res, next) => {
    const criteria: SearchCriteria = searchQuery.value(res)
    const ref = String(req.params.ref)

    const problem = validateCriteria(criteria, options.deps.settings.today())
    if (problem !== undefined) {
      next(criteriaError(problem))
      return
    }

    void runSearch(options, criteria).then((response) => {
      const found = response.properties.find(
        (property) => property.ref === ref || property.slug === ref,
      )

      if (found === undefined) {
        next(new NotFoundError(`properti ${ref} tidak ada di hasil pencarian ini`))
        return
      }

      res.json(success({ property: found, meta: response.meta }))
    }, next)
  }
}

/**
 * Membatalkan hasil satu kota — untuk keperluan operasi (FR-30 dan sesudahnya).
 *
 * Hanya lapis pertama. Pembatalan oleh operasi hampir selalu karena pandangan
 * GABUNGANNYA yang keliru — aturan markup berubah, katalog diperbaiki — bukan
 * karena jawaban supplier-nya salah. Ikut membuang lapis kedua berarti memaksa
 * lima supplier menjawab ulang untuk data yang masih benar.
 */
function invalidateHandler(options: SearchRouterOptions): RequestHandler {
  return (_req, res, next) => {
    const { city } = invalidateBody.value(res)
    const tag = `search:city:${city.trim().replace(/\s+/g, ' ').toLowerCase()}`

    void options.deps.results.invalidateCity(tag).then((removed) => {
      res.json(success({ city, removed }))
    }, next)
  }
}

async function runSearch(
  options: SearchRouterOptions,
  criteria: SearchCriteria,
): Promise<SearchResponse> {
  return await search(options.deps, criteria, {
    deadline: options.deadline,
    sightings: options.sightings,
    onLateError: options.onLateError,
  })
}

const PROBLEM_MESSAGES: Readonly<Record<CriteriaProblem, string>> = {
  checkout_not_after_checkin: 'tanggal keluar harus setelah tanggal masuk',
  stay_too_long: 'menginap terlalu lama',
  check_in_in_past: 'tanggal masuk sudah lewat',
  too_far_ahead: 'tanggal masuk terlalu jauh ke depan',
}

function criteriaError(problem: CriteriaProblem): AppError {
  return new AppError({
    code: 'VALIDATION_ERROR',
    httpStatus: 400,
    message: PROBLEM_MESSAGES[problem],
    details: { problem },
  })
}
