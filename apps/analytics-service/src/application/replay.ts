import type { AnalyticsStore, ConsumerOffsets } from './ports.js'

/**
 * Membangun ulang seluruh agregat dari awal topik (Step 27).
 *
 * Ini bukan fitur tambahan, melainkan klaim yang harus dapat dibuktikan:
 * agregat adalah TURUNAN dari log peristiwa, dan log itulah sumber
 * kebenarannya. Kalau agregat dapat dihapus lalu dibangun kembali persis sama,
 * cacat di logika agregasi diperbaiki dengan memperbaiki kodenya lalu
 * memutar ulang — bukan dengan skrip migrasi data yang ditulis tangan.
 *
 * Urutan langkahnya dipilih supaya kegagalan di tengah tidak pernah
 * MENGHILANGKAN data:
 *
 * 1. Group harus kosong (service berhenti). Anggota yang masih hidup akan
 *    meng-commit offset lamanya dan membatalkan pemutaran balik.
 * 2. Offset diputar ke awal LEBIH DULU. Bila langkah 3 gagal, service yang
 *    menyala membaca ulang semuanya dan daftar pesan terhitung menolak
 *    setiap pesan sebagai duplikat — agregat lama tetap utuh. Urutan
 *    sebaliknya (kosongkan dulu) yang gagal di langkah 2 meninggalkan agregat
 *    kosong dengan offset di ujung topik: data hilang sampai seseorang sadar.
 * 3. Penghitung, pemetaan supplier, dan daftar pesan dikosongkan bersama.
 *
 * Batas yang dinyatakan: "awal topik" adalah awal yang MASIH DISIMPAN broker.
 * tbe.search.v1 dan tbe.supplier.v1 beretensi 7 hari (topics.ts), jadi replay
 * hanya dapat membangun ulang agregat pencarian dan degradasi supplier tujuh
 * hari terakhir. Topik pemesanan dan pembayaran beretensi 90 hari.
 */

export interface ReplayDeps {
  readonly store: AnalyticsStore
  readonly offsets: ConsumerOffsets
}

export type ReplayOutcome =
  | { readonly kind: 'rewound'; readonly topics: readonly string[] }
  | { readonly kind: 'group_active'; readonly members: number; readonly state: string }

export async function replay(
  deps: ReplayDeps,
  target: { readonly groupId: string; readonly topics: readonly string[] },
): Promise<ReplayOutcome> {
  const check = await deps.offsets.check(target.groupId)
  if (check.kind === 'active') {
    return { kind: 'group_active', members: check.members, state: check.state }
  }

  await deps.offsets.rewindToEarliest(target.groupId, target.topics)
  await deps.store.reset()

  return { kind: 'rewound', topics: target.topics }
}
