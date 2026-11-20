import type { MarkupRule, MarkupScope } from './markup.js'
import { specificity } from './markup.js'

/**
 * Perubahan aturan markup yang hendak dipratinjau (Step 27, FR-30).
 *
 * Pratinjau menjawab satu pertanyaan sebelum operator menekan simpan: harga
 * mana yang berubah, dan menjadi berapa. Caranya menerapkan perubahan pada
 * SALINAN daftar aturan di memori, lalu menghitung harga dengan mesin yang
 * sama persis dengan pencarian (`pricerFor`). Tidak ada yang tersimpan.
 *
 * Alternatif yang ditolak: menyimpan aturan sebagai nonaktif lalu
 * "mengaktifkan untuk pratinjau". Itu menulis ke tabel yang dibaca setiap
 * pencarian, dan pratinjau yang gagal di tengah meninggalkan aturan setengah
 * jadi untuk operator berikutnya.
 */

export type MarkupChange =
  | { readonly kind: 'create'; readonly rule: Omit<MarkupRule, 'id'> }
  | {
      readonly kind: 'update'
      readonly id: string
      readonly patch: {
        readonly priority?: number | undefined
        readonly percentageBasisPoints?: number | undefined
        readonly isActive?: boolean | undefined
      }
    }
  | { readonly kind: 'deactivate'; readonly id: string }

/**
 * Pengenal sementara aturan baru. Aturan sungguhan mendapat UUID saat
 * disimpan, dan pengenal hanya dipakai sebagai pemutus TERAKHIR (prioritas dan
 * cakupan sama persis). Kasus itu ditandai `isTieBreakUncertain` alih-alih
 * dipura-purakan pasti.
 */
export const PREVIEW_RULE_ID = 'pratinjau'

export type AppliedChange =
  | {
      readonly ok: true
      readonly rules: readonly MarkupRule[]
      readonly isTieBreakUncertain: boolean
    }
  | { readonly ok: false; readonly reason: 'rule_not_found' }

export function applyChange(rules: readonly MarkupRule[], change: MarkupChange): AppliedChange {
  if (change.kind === 'create') {
    const candidate: MarkupRule = { ...change.rule, id: PREVIEW_RULE_ID }
    return {
      ok: true,
      rules: [...rules, candidate],
      isTieBreakUncertain: candidate.isActive && rules.some((rule) => ties(rule, candidate)),
    }
  }

  if (!rules.some((rule) => rule.id === change.id)) return { ok: false, reason: 'rule_not_found' }

  const next = rules.map((rule) => (rule.id === change.id ? patched(rule, change) : rule))
  return { ok: true, rules: next, isTieBreakUncertain: false }
}

function patched(rule: MarkupRule, change: Exclude<MarkupChange, { kind: 'create' }>): MarkupRule {
  if (change.kind === 'deactivate') return { ...rule, isActive: false }

  const { patch } = change
  return {
    ...rule,
    ...(patch.priority === undefined ? {} : { priority: patch.priority }),
    ...(patch.percentageBasisPoints === undefined
      ? {}
      : { percentageBasisPoints: patch.percentageBasisPoints }),
    ...(patch.isActive === undefined ? {} : { isActive: patch.isActive }),
  }
}

/** Dua aturan aktif yang hanya dapat dibedakan oleh pengenalnya untuk cakupan yang sama. */
function ties(rule: MarkupRule, candidate: MarkupRule): boolean {
  return (
    rule.isActive &&
    rule.priority === candidate.priority &&
    specificity(rule.scope) === specificity(candidate.scope) &&
    sameScope(rule.scope, candidate.scope)
  )
}

function sameScope(a: MarkupScope, b: MarkupScope): boolean {
  return a.supplier === b.supplier && a.city?.toLowerCase() === b.city?.toLowerCase()
}
