import { describe, expect, test } from 'vitest'
import { createSnapshotHolder } from './snapshot-holder.js'
import { countingSnapshots, mapping, property, sourceOf } from '../testing/fakes.js'
import type { CatalogSource, SnapshotStore } from '../application/ports.js'

/**
 * Snapshot yang dipegang proses.
 *
 * Yang diuji di sini adalah tiga keadaan yang membedakan katalog yang tetap
 * melayani dari katalog yang menghilang: Redis terisi, Redis kosong, dan
 * keduanya gagal.
 */

const PADMA = property()
const CONTENTS = { properties: [PADMA], mappings: [mapping()] }

function failingSource(): CatalogSource {
  return {
    load: async () => {
      await Promise.resolve()
      throw new Error('postgres sedang tumbang')
    },
  }
}

function holderOn(
  snapshots: ReturnType<typeof countingSnapshots>,
  source: CatalogSource,
  errors: unknown[] = [],
) {
  return createSnapshotHolder({
    snapshots,
    source,
    now: () => 1_000,
    onError: (error) => errors.push(error),
  })
}

describe('memuat dari Redis', () => {
  test('memakai salinan di Redis tanpa menyentuh basis data', () => {
    // Inilah yang membuat sepuluh instance memuat katalog dari Postgres
    // sekali, bukan sepuluh kali.
    const snapshots = countingSnapshots(CONTENTS)
    const source = sourceOf(CONTENTS)
    const loads = { count: 0 }
    const counted: CatalogSource = {
      load: async () => {
        loads.count += 1
        return await source.load()
      },
    }

    const holder = holderOn(snapshots, counted)

    return holder.refresh().then((result) => {
      expect(result).toBe('from_cache')
      expect(loads.count).toBe(0)
    })
  })

  test('snapshot tersedia secara sinkron sesudahnya', async () => {
    // Sinkron karena jalur pencarian tidak boleh menunggu apa pun.
    const holder = holderOn(countingSnapshots(CONTENTS), sourceOf(CONTENTS))

    await holder.refresh()

    expect(holder.current()?.propertyBySlug(PADMA.slug)?.name).toBe(PADMA.name)
  })

  test('mencatat kapan terakhir dimuat', async () => {
    const holder = holderOn(countingSnapshots(CONTENTS), sourceOf(CONTENTS))

    expect(holder.loadedAt).toBeUndefined()
    await holder.refresh()
    expect(holder.loadedAt).toBe(1_000)
  })
})

describe('Redis kosong', () => {
  test('memuat dari basis data lalu mengisi Redis', async () => {
    const snapshots = countingSnapshots()

    const holder = holderOn(snapshots, sourceOf(CONTENTS))
    const result = await holder.refresh()

    expect(result).toBe('from_database')
    expect(snapshots.calls.writes).toBe(1)
    expect(holder.current()?.propertyBySlug(PADMA.slug)).toBeDefined()
  })

  test('instance berikutnya memakai yang sudah diisi', async () => {
    const snapshots = countingSnapshots()

    await holderOn(snapshots, sourceOf(CONTENTS)).refresh()
    const second = holderOn(snapshots, sourceOf(CONTENTS))

    expect(await second.refresh()).toBe('from_cache')
    expect(snapshots.calls.writes).toBe(1)
  })
})

describe('keduanya gagal', () => {
  test('kegagalan basis data dilaporkan, bukan ditelan', async () => {
    const errors: unknown[] = []
    const holder = holderOn(countingSnapshots(), failingSource(), errors)

    expect(await holder.refresh()).toBe('failed')
    expect(errors).toHaveLength(1)
  })

  test('snapshot lama dipertahankan saat penyegaran gagal', async () => {
    // Katalog yang tertinggal jauh lebih baik daripada tidak ada katalog sama
    // sekali. Tanpa katalog, setiap properti dari setiap supplier tampil
    // sebagai belum terpetakan — hasil yang terlihat berfungsi dan seluruhnya
    // salah.
    const snapshots = countingSnapshots(CONTENTS)
    const holder = holderOn(snapshots, failingSource())

    await holder.refresh()
    expect(holder.current()).toBeDefined()

    // Redis kehilangan isinya, basis data juga tumbang.
    const broken = holderOn(countingSnapshots(), failingSource())
    await broken.refresh()

    // Yang pertama tetap memegang katalognya.
    expect(holder.current()?.propertyBySlug(PADMA.slug)).toBeDefined()
    expect(broken.current()).toBeUndefined()
  })

  test('penyegaran gagal tidak mengubah waktu muat terakhir', async () => {
    const holder = holderOn(countingSnapshots(CONTENTS), sourceOf(CONTENTS))
    await holder.refresh()

    const failing = holderOn(countingSnapshots(), failingSource())
    await failing.refresh()

    expect(failing.loadedAt).toBeUndefined()
    expect(holder.loadedAt).toBe(1_000)
  })

  test('Redis yang tetap kosong setelah ditulis dilaporkan gagal', async () => {
    // Redis tumbang untuk menulis DAN membaca. Penulisannya tidak melempar —
    // implementasi Redis menelan galatnya dengan sengaja — jadi keadaan ini
    // hanya ketahuan dari pembacaan yang tetap kosong.
    const errors: unknown[] = []
    const blackhole: SnapshotStore = {
      async read() {
        await Promise.resolve()
        return undefined
      },
      async write() {
        await Promise.resolve()
      },
    }

    const holder = createSnapshotHolder({
      snapshots: blackhole,
      source: sourceOf(CONTENTS),
      now: () => 1_000,
      onError: (error) => errors.push(error),
    })

    expect(await holder.refresh()).toBe('failed')
    expect(errors).toHaveLength(1)
  })
})
