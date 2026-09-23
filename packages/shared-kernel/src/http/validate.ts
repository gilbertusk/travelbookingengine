import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { z } from 'zod'
import { ValidationError } from '../errors/app-error.js'

/**
 * Validasi masukan di batas sistem — CONVENTIONS.md bagian 6.
 *
 * Hasil validasi disimpan di res.locals, bukan menimpa req.body atau req.query.
 * Pada Express 5 req.query adalah getter dan tidak dapat ditulis; menyimpan
 * terpisah juga membuat jelas mana data mentah dan mana yang sudah tervalidasi.
 *
 * validate() mengembalikan middleware yang sekaligus membawa pengakses
 * bertipe. Bentuk ini dipilih supaya tipe hasil validasi selalu berasal dari
 * skema yang sama dengan yang memvalidasinya — pengakses bertipe generik bebas
 * hanyalah type assertion yang menyamar, dan akan diam saja ketika skemanya
 * berubah tetapi pemanggilnya tidak.
 *
 * Pemakaian:
 *
 *   const searchQuery = validate(searchSchema, 'query')
 *
 *   app.get('/search', searchQuery, (_req, res) => {
 *     const { city, guests } = searchQuery.value(res)
 *   })
 */

export type ValidationSource = 'body' | 'query' | 'params'

const VALIDATED_KEY = 'validated'

type ValidatedStore = Partial<Record<ValidationSource, unknown>>

export type ValidatingMiddleware<T> = RequestHandler & {
  value(res: Response): T
}

function storeOf(res: Response): ValidatedStore {
  // res.locals bertipe Record<string, any> pada @types/express; dipersempit ke
  // unknown agar tidak ada nilai any yang merembet ke pemanggil.
  const locals = res.locals as Record<string, unknown>
  const existing = locals[VALIDATED_KEY]

  if (existing !== undefined) {
    return existing as ValidatedStore
  }

  const store: ValidatedStore = {}
  locals[VALIDATED_KEY] = store
  return store
}

export function validate<S extends z.ZodType>(
  schema: S,
  source: ValidationSource,
): ValidatingMiddleware<z.infer<S>> {
  const middleware: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source])

    if (!result.success) {
      next(
        new ValidationError('Masukan tidak sah', {
          source,
          issues: result.error.issues.map((issue) => ({
            field: issue.path.join('.'),
            message: issue.message,
          })),
        }),
      )
      return
    }

    storeOf(res)[source] = result.data
    next()
  }

  return Object.assign(middleware, {
    value(res: Response): z.infer<S> {
      const stored = storeOf(res)[source]

      if (stored === undefined) {
        throw new Error(
          `Tidak ada hasil validasi untuk "${source}". ` +
            'Pastikan middleware dari validate() terpasang pada rute ini.',
        )
      }

      return stored as z.infer<S>
    },
  })
}
