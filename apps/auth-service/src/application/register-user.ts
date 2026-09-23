import { err, ok, type Result } from '@tbe/shared-kernel'
import { createEmail, type EmailProblem } from '../domain/email.js'
import { asRawPassword, validatePassword, type PasswordProblem } from '../domain/password.js'
import type { User } from '../domain/user.js'
import { issueTokens } from './issue-tokens.js'
import type { AuthDeps, IssuedTokens } from './ports.js'

export interface RegisterInput {
  readonly email: string
  readonly password: string
  readonly name: string
}

export type RegisterFailure =
  | { readonly kind: 'invalid_email'; readonly problem: EmailProblem }
  | { readonly kind: 'weak_password'; readonly problem: PasswordProblem }
  | { readonly kind: 'email_taken' }

export interface RegisterSuccess {
  readonly user: User
  readonly tokens: IssuedTokens
}

export async function registerUser(
  deps: AuthDeps,
  input: RegisterInput,
): Promise<Result<RegisterSuccess, RegisterFailure>> {
  const email = createEmail(input.email)
  if (!email.ok) return err({ kind: 'invalid_email', problem: email.error })

  const weakness = validatePassword(input.password)
  if (weakness !== undefined) return err({ kind: 'weak_password', problem: weakness })

  // Pemeriksaan ini hanya mengurangi jumlah galat yang sampai ke database.
  // Penjamin sebenarnya adalah batasan unik pada kolom email — dua pendaftaran
  // serentak dengan surel sama akan lolos pemeriksaan ini bersama-sama.
  const existing = await deps.users.findByEmail(email.value)
  if (existing !== undefined) return err({ kind: 'email_taken' })

  const user = await deps.users.create({
    id: deps.ids.newId(),
    email: email.value,
    passwordHash: await deps.hasher.hash(asRawPassword(input.password)),
    name: input.name.trim(),
  })

  return ok({ user, tokens: await issueTokens(deps, user) })
}
