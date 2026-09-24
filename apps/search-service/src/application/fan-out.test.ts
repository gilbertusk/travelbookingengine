import { describe, expect, test } from 'vitest'
import type { SupplierCode, SupplierSearchResult } from '@tbe/supplier-adapters'
import { fanOut, type Deadline, type SupplierCall } from './fan-out.js'

/**
 * Fan-out dengan anggaran waktu.
 *
 * Seluruh berkas ini dikendalikan tangan: anggarannya dihabiskan ketika
 * pengujian memutuskannya, dan setiap supplier menjawab ketika pengujian
 * memutuskannya. Tidak ada `setTimeout`, tidak ada pengukuran waktu.
 *
 * Uji yang benar-benar menunggu 1200ms akan lambat; uji yang menunggu 50ms
 * akan lulus di mesin cepat dan gagal di CI yang sedang sibuk. Keduanya
 * menguji penjadwal sistem operasi, bukan kode ini.
 */

function result(supplier: SupplierCode): SupplierSearchResult {
  return {
    supplier,
    checkIn: '2026-11-10',
    checkOut: '2026-11-12',
    properties: [],
  }
}

/** Anggaran yang dihabiskan tangan. */
function manualDeadline(): { factory: () => Deadline; expire: () => void; cancelled: boolean } {
  let release = (): void => undefined
  const state = { cancelled: false }
  const expired = new Promise<void>((resolve) => {
    release = resolve
  })

  return {
    factory: () => ({
      expired,
      cancel: () => {
        state.cancelled = true
      },
    }),
    expire: () => {
      release()
    },
    get cancelled() {
      return state.cancelled
    },
  }
}

/** Supplier yang menjawab ketika pengujian memutuskannya. */
function controlled(supplier: SupplierCode): {
  call: SupplierCall
  respond: () => void
  fail: (message?: string) => void
} {
  let settle: (value: SupplierSearchResult) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined

  const promise = new Promise<SupplierSearchResult>((resolve, rejectFn) => {
    settle = resolve
    reject = rejectFn
  })

  return {
    call: { supplier, run: async () => await promise },
    respond: () => {
      settle(result(supplier))
    },
    fail: (message = 'supplier tumbang') => {
      reject(new Error(message))
    },
  }
}

function immediate(supplier: SupplierCode): SupplierCall {
  return { supplier, run: async () => await Promise.resolve(result(supplier)) }
}

function failing(supplier: SupplierCode, message = 'supplier tumbang'): SupplierCall {
  return {
    supplier,
    run: async () => {
      await Promise.resolve()
      throw new Error(message)
    },
  }
}

function options(
  deadline: ReturnType<typeof manualDeadline>,
  extra: Partial<Parameters<typeof fanOut>[1]> = {},
) {
  return {
    budgetMs: 1_200,
    deadline: deadline.factory,
    onLate: () => undefined,
    onLateError: () => undefined,
    ...extra,
  }
}

/** Memberi kesempatan microtask yang tertunda untuk berjalan. */
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('seluruh supplier menjawab dalam anggaran', () => {
  test('hasilnya lengkap tanpa menunggu anggaran habis', async () => {
    // Anggaran TIDAK dihabiskan di sini. Kalau fan-out menunggunya, uji ini
    // akan menggantung — dan itu justru yang ingin dibuktikan tidak terjadi.
    const deadline = manualDeadline()

    const run = await fanOut([immediate('SKY'), immediate('NOVA')], options(deadline))

    expect(run.results).toHaveLength(2)
    expect(run.outcomes.map((outcome) => outcome.kind)).toEqual(['responded', 'responded'])
  })

  test('timer dilepas setelah semuanya menjawab', async () => {
    // Timer yang tidak dilepas menahan proses tetap hidup, dan pada ribuan
    // pencarian per menit ia menumpuk.
    const deadline = manualDeadline()

    await fanOut([immediate('SKY')], options(deadline))

    expect(deadline.cancelled).toBe(true)
  })
})

describe('satu supplier lambat', () => {
  test('hasil dari yang sudah menjawab tetap kembali', async () => {
    // Inilah jawaban atas masalah nomor 1 di PRD. LUNA belum menjawab, dan
    // pencarian tetap berguna.
    const deadline = manualDeadline()
    const luna = controlled('LUNA')

    const running = fanOut([immediate('SKY'), luna.call], options(deadline))
    await flush()
    deadline.expire()

    const run = await running

    expect(run.results.map((item) => item.supplier)).toEqual(['SKY'])
    expect(run.outcomes.find((item) => item.supplier === 'LUNA')?.kind).toBe('timed_out')
  })

  test('yang lambat TIDAK dibatalkan, dan hasilnya disimpan', async () => {
    // Detail yang membedakan implementasi serius dari yang asal jalan. Tanpa
    // ini, supplier lambat tidak pernah berkontribusi sama sekali dan
    // inventarisnya hilang selamanya dari hasil pencarian.
    const deadline = manualDeadline()
    const luna = controlled('LUNA')
    const late: SupplierSearchResult[] = []

    const running = fanOut(
      [immediate('SKY'), luna.call],
      options(deadline, { onLate: (item) => late.push(item) }),
    )
    await flush()
    deadline.expire()
    await running

    expect(late).toEqual([])

    // LUNA akhirnya menjawab, jauh setelah pencariannya dikembalikan.
    luna.respond()
    await flush()

    expect(late.map((item) => item.supplier)).toEqual(['LUNA'])
  })

  test('yang lambat lalu gagal dilaporkan, tidak ditelan', async () => {
    const deadline = manualDeadline()
    const luna = controlled('LUNA')
    const errors: string[] = []

    const running = fanOut(
      [immediate('SKY'), luna.call],
      options(deadline, { onLateError: (supplier) => errors.push(supplier) }),
    )
    await flush()
    deadline.expire()
    await running

    luna.fail()
    await flush()

    expect(errors).toEqual(['LUNA'])
  })

  test('jawaban terlambat tidak ikut masuk hasil pencarian ini', async () => {
    const deadline = manualDeadline()
    const luna = controlled('LUNA')

    const running = fanOut([immediate('SKY'), luna.call], options(deadline))
    await flush()
    deadline.expire()

    const run = await running
    luna.respond()
    await flush()

    // Objek hasilnya disalin saat dikembalikan; jawaban terlambat tidak dapat
    // menyusup ke dalamnya setelahnya.
    expect(run.results).toHaveLength(1)
  })

  test('seluruh supplier lambat menghasilkan hasil kosong, bukan galat', async () => {
    const deadline = manualDeadline()

    const running = fanOut([controlled('LUNA').call, controlled('ZEPH').call], options(deadline))
    await flush()
    deadline.expire()

    const run = await running

    expect(run.results).toEqual([])
    expect(run.outcomes.every((item) => item.kind === 'timed_out')).toBe(true)
  })
})

describe('satu supplier gagal', () => {
  test('tidak membatalkan yang lain', async () => {
    // Pola allSettled, bukan all. Yang kedua menghasilkan pencarian kosong
    // karena satu supplier sedang dipelihara.
    const deadline = manualDeadline()

    const run = await fanOut([failing('ZEPH'), immediate('SKY')], options(deadline))

    expect(run.results.map((item) => item.supplier)).toEqual(['SKY'])
  })

  test('kegagalannya ikut dilaporkan beserta sebabnya', async () => {
    const deadline = manualDeadline()

    const run = await fanOut([failing('ZEPH', 'circuit terbuka')], options(deadline))
    const outcome = run.outcomes[0]

    expect(outcome?.kind).toBe('failed')
    if (outcome?.kind !== 'failed') return
    expect(outcome.reason).toBe('circuit terbuka')
  })

  test('seluruh supplier gagal tetap mengembalikan hasil, bukan melempar', async () => {
    const deadline = manualDeadline()

    const run = await fanOut([failing('ZEPH'), failing('ORBIT')], options(deadline))

    expect(run.results).toEqual([])
    expect(run.outcomes).toHaveLength(2)
  })

  test('galat yang bukan Error tetap tertangani', async () => {
    // Jawaban yang gagal diurai dapat menghasilkan lemparan apa pun. Kalau
    // penanganannya mengandaikan `Error`, `error.message` menjadi `undefined`
    // dan sebab kegagalannya hilang tepat saat paling dibutuhkan.
    const deadline = manualDeadline()
    const weird: SupplierCall = {
      supplier: 'ORBIT',
      run: async () => {
        await Promise.resolve()
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- justru inilah yang diuji
        throw { kode: 'bukan-error' }
      },
    }

    const run = await fanOut([weird], options(deadline))
    const outcome = run.outcomes[0]

    expect(outcome?.kind).toBe('failed')
    if (outcome?.kind !== 'failed') return
    expect(outcome.reason).toBe('galat tidak dikenal')
  })
})

describe('supplier yang dilewati', () => {
  test('dilaporkan tanpa pernah dipanggil', async () => {
    // Supplier dengan pemutus terbuka tidak dipanggil sama sekali: bukan
    // dipanggil lalu ditolak cepat, melainkan tidak dipanggil.
    const deadline = manualDeadline()

    const run = await fanOut(
      [immediate('SKY')],
      options(deadline, { skipped: [{ supplier: 'LUNA', reason: 'circuit_open' }] }),
    )

    const luna = run.outcomes.find((item) => item.supplier === 'LUNA')
    expect(luna?.kind).toBe('skipped')
    if (luna?.kind !== 'skipped') return
    expect(luna.reason).toBe('circuit_open')
  })

  test('supplier nonaktif dibedakan dari pemutus terbuka', async () => {
    // Keduanya sama-sama tidak dipanggil, tetapi artinya berbeda bagi
    // operator: yang satu keputusan manusia, yang satu gejala kegagalan.
    const deadline = manualDeadline()

    const run = await fanOut(
      [immediate('SKY')],
      options(deadline, {
        skipped: [
          { supplier: 'LUNA', reason: 'circuit_open' },
          { supplier: 'ORBIT', reason: 'inactive' },
        ],
      }),
    )

    expect(run.outcomes.filter((item) => item.kind === 'skipped')).toHaveLength(2)
  })

  test('tanpa satu pun supplier yang dipanggil, hasilnya kosong', async () => {
    const deadline = manualDeadline()

    const run = await fanOut(
      [],
      options(deadline, { skipped: [{ supplier: 'LUNA', reason: 'circuit_open' }] }),
    )

    expect(run.results).toEqual([])
    expect(run.outcomes).toHaveLength(1)
  })
})
