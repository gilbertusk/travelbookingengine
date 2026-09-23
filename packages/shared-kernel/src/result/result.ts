/**
 * Result untuk error yang dapat diantisipasi.
 *
 * CONVENTIONS.md bagian 5: error yang bisa diantisipasi dikembalikan sebagai
 * nilai, bukan dilempar. Harga supplier yang berubah bukan kegagalan — itu
 * jawaban sah yang harus ditangani pemanggil, dan tipe inilah yang memaksa
 * pemanggil menanganinya.
 */

export interface Ok<T> {
  readonly ok: true
  readonly value: T
}

export interface Err<E> {
  readonly ok: false
  readonly error: E
}

export type Result<T, E> = Ok<T> | Err<E>

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value }
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error }
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok
}

export function map<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result
}

export function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  return result.ok ? result : err(fn(result.error))
}

export function andThen<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>,
): Result<U, E> {
  return result.ok ? fn(result.value) : result
}

export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback
}

/**
 * Memisahkan sekumpulan Result menjadi nilai yang berhasil dan yang gagal.
 * Dipakai pada fan-out supplier di Step 13, ketika sebagian supplier menjawab
 * dan sebagian gagal — keduanya perlu dilaporkan, bukan salah satunya saja.
 */
export function partition<T, E>(
  results: readonly Result<T, E>[],
): { readonly values: readonly T[]; readonly errors: readonly E[] } {
  const values: T[] = []
  const errors: E[] = []

  for (const result of results) {
    if (result.ok) values.push(result.value)
    else errors.push(result.error)
  }

  return { values, errors }
}
