import { randomBytes } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'
import type { Clock, IdFactory, TokenFactory } from '../application/ports.js'

/** Jam, pembuat pengenal, dan pembuat token yang sesungguhnya. */

export const systemClock: Clock = {
  now: () => new Date(),
}

/** UUID v7: terurut menurut waktu, ramah indeks B-tree. Bukan rahasia. */
export const uuidFactory: IdFactory = {
  next: () => uuidv7(),
}

/**
 * Token kunci objek: 32 bita dari CSPRNG, base64url. Bukan UUID — UUID v7
 * berawalan cap waktu dan sebagian bitnya dapat diramalkan.
 */
export const OBJECT_TOKEN_BYTES = 32

export const secureTokens: TokenFactory = {
  next: () => randomBytes(OBJECT_TOKEN_BYTES).toString('base64url'),
}
