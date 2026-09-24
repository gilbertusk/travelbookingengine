import type { SupplierCode, SupplierSearchResult } from '@tbe/supplier-adapters'

/**
 * Fan-out dengan anggaran waktu.
 *
 * Inilah jawaban atas masalah nomor 1 di PRD: latensi supplier tidak seragam.
 * LUNA menjawab dalam tiga detik; menunggunya berarti seluruh pencarian
 * menunggu tiga detik, dan pengguna sudah pergi jauh sebelum itu.
 *
 * Dua keputusan yang membedakan ini dari `Promise.race` biasa:
 *
 * 1. **Supplier yang melewati anggaran TIDAK dibatalkan.** Ia dibiarkan
 *    selesai di latar belakang dan hasilnya disimpan ke cache untuk pencarian
 *    berikutnya. Tanpa ini, supplier lambat tidak pernah berkontribusi sama
 *    sekali dan inventarisnya hilang selamanya dari hasil — pengguna yang
 *    mencari Bali tidak akan pernah melihat satu pun kamar LUNA, bukan karena
 *    tidak ada, melainkan karena selalu terlambat.
 *
 * 2. **Satu supplier gagal tidak membatalkan yang lain.** Pola allSettled,
 *    bukan all. Yang pertama menghasilkan pencarian yang tetap berguna; yang
 *    kedua menghasilkan pencarian yang kosong karena satu supplier sedang
 *    dipelihara.
 *
 * Anggaran diwakili port [Deadline], bukan `setTimeout` langsung, supaya
 * pengujian dapat menghabiskannya kapan saja. Uji yang benar-benar menunggu
 * 1200ms akan lambat, dan uji yang menunggu 50ms akan rapuh.
 */

export interface Deadline {
  /** Selesai ketika anggaran habis. Tidak pernah menolak. */
  readonly expired: Promise<void>
  /** Melepaskan timer. Dipanggil ketika seluruh supplier sudah menjawab. */
  cancel(): void
}

export type DeadlineFactory = (budgetMs: number) => Deadline

export interface SupplierCall {
  readonly supplier: SupplierCode
  run(): Promise<SupplierSearchResult>
}

export type SupplierOutcome =
  | { readonly kind: 'responded'; readonly supplier: SupplierCode; readonly fromCache: boolean }
  | { readonly kind: 'timed_out'; readonly supplier: SupplierCode }
  | { readonly kind: 'failed'; readonly supplier: SupplierCode; readonly reason: string }
  | {
      readonly kind: 'skipped'
      readonly supplier: SupplierCode
      readonly reason: 'circuit_open' | 'inactive'
    }

export interface FanOutResult {
  readonly results: readonly SupplierSearchResult[]
  readonly outcomes: readonly SupplierOutcome[]
}

export interface FanOutOptions {
  readonly budgetMs: number
  readonly deadline: DeadlineFactory
  /**
   * Dipanggil ketika supplier yang melewati anggaran akhirnya menjawab.
   *
   * Di sinilah hasil supplier lambat disimpan supaya pencarian BERIKUTNYA
   * mendapatkannya. Dibuat sebagai callback, bukan cache langsung, supaya
   * fan-out tetap tidak tahu apa pun tentang Redis.
   */
  readonly onLate: (result: SupplierSearchResult) => void
  /** Kegagalan di latar belakang dilaporkan, tidak ditelan diam-diam. */
  readonly onLateError: (supplier: SupplierCode, error: unknown) => void
  /** Supplier yang dilewati tanpa dipanggil sama sekali. */
  readonly skipped?: readonly { supplier: SupplierCode; reason: 'circuit_open' | 'inactive' }[]
}

export async function fanOut(
  calls: readonly SupplierCall[],
  options: FanOutOptions,
): Promise<FanOutResult> {
  const settled = new Map<SupplierCode, SupplierOutcome>()
  const results: SupplierSearchResult[] = []
  const deadline = options.deadline(options.budgetMs)

  const attempts = calls.map((call) => attempt(call, settled, results, options))

  // Selesai ketika SELURUH supplier menjawab, atau ketika anggaran habis —
  // mana pun yang lebih dulu. `allSettled` di sini tidak akan pernah menolak,
  // karena setiap percobaan sudah menangkap galatnya sendiri.
  await Promise.race([Promise.allSettled(attempts), deadline.expired])
  deadline.cancel()

  for (const skipped of options.skipped ?? []) {
    settled.set(skipped.supplier, {
      kind: 'skipped',
      supplier: skipped.supplier,
      reason: skipped.reason,
    })
  }

  for (const call of calls) {
    if (settled.has(call.supplier)) continue

    // Belum menjawab saat anggaran habis. Ia TIDAK dibatalkan — penanganan
    // di [attempt] tetap berjalan dan akan menyimpan hasilnya ke cache.
    settled.set(call.supplier, { kind: 'timed_out', supplier: call.supplier })
  }

  return { results: [...results], outcomes: [...settled.values()] }
}

/**
 * Satu percobaan ke satu supplier.
 *
 * Penanganannya dipasang SEKALI, dan ia yang memutuskan apakah jawabannya
 * masuk ke pencarian ini atau ke cache untuk pencarian berikutnya —
 * bergantung pada apakah anggaran sudah habis saat jawabannya tiba.
 *
 * Satu penangan, bukan dua. Dua penangan atas promise yang sama berarti
 * jawaban yang sama dapat diproses dua kali, dan itu bug yang hanya muncul
 * ketika supplier menjawab tepat di batas anggaran — keadaan yang paling
 * jarang terjadi dan paling sulit ditiru ulang.
 *
 * Keamanannya bertumpu pada satu sifat JavaScript: setelah `Promise.race` di
 * [fanOut] selesai, blok yang menandai siapa saja yang kehabisan waktu
 * berjalan tanpa satu pun `await` di dalamnya. Tidak ada celah bagi jawaban
 * yang tiba untuk menyelinap di antaranya.
 */
async function attempt(
  call: SupplierCall,
  settled: Map<SupplierCode, SupplierOutcome>,
  results: SupplierSearchResult[],
  options: FanOutOptions,
): Promise<void> {
  try {
    const result = await call.run()

    if (settled.has(call.supplier)) {
      // Terlambat. Anggaran sudah habis dan jawaban ini tidak ikut ke
      // pencarian sekarang — tetapi ia disimpan, dan pencarian berikutnya
      // mendapatkannya tanpa menunggu.
      options.onLate(result)
      return
    }

    settled.set(call.supplier, { kind: 'responded', supplier: call.supplier, fromCache: false })
    results.push(result)
  } catch (error) {
    if (settled.has(call.supplier)) {
      // Terlambat DAN gagal. Tidak ada yang disimpan, tetapi kegagalannya
      // tetap dilaporkan: supplier yang selalu gagal setelah anggaran habis
      // tidak akan terlihat di metrik pencarian mana pun.
      options.onLateError(call.supplier, error)
      return
    }

    settled.set(call.supplier, {
      kind: 'failed',
      supplier: call.supplier,
      reason: messageOf(error),
    })
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'galat tidak dikenal'
}
