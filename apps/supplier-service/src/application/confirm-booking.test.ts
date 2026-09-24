import { describe, expect, test } from 'vitest'
import { confirmBooking } from './confirm-booking.js'
import { booking, err, failure, harness, ok } from '../testing/fakes.js'

/**
 * Pemulihan aman setelah `book` kehabisan waktu.
 *
 * Ini satu-satunya berkas uji di seluruh project ini yang secara langsung
 * mencegah kerugian uang sungguhan. Yang dijaga: ketika `book` kehabisan
 * waktu, sistem TIDAK boleh mengirim `book` kedua. Ia harus bertanya lebih
 * dulu dengan kunci idempotensi yang sama.
 *
 * Setiap pengujian di bawah memeriksa urutan panggilan yang benar-benar
 * dikirim ke supplier, bukan hanya hasil akhirnya. Hasil akhir yang benar
 * dengan dua `book` terkirim adalah dua kamar yang dibayar.
 */

const PARAMS = {
  supplier: 'SKY' as const,
  holdRef: 'hld_1',
  guestName: 'Budi Santoso',
  idempotencyKey: 'kunci-tetap-1',
}

describe('jalur berhasil', () => {
  test('pemesanan yang langsung berhasil dikembalikan apa adanya', async () => {
    const world = harness({ script: { book: [ok(booking('SKY', 'bkg_1'))] } })

    const outcome = await confirmBooking(world.deps, PARAMS)

    expect(outcome.status).toBe('confirmed')
    if (outcome.status !== 'confirmed') return
    expect(outcome.adopted).toBe(false)
    expect(world.gateway.calls).toEqual(['book'])
  })

  test('kunci idempotensi diteruskan apa adanya ke supplier', async () => {
    const world = harness({ script: { book: [ok(booking('SKY', 'bkg_1'))] } })

    await confirmBooking(world.deps, PARAMS)

    expect(world.log.entries[0]?.idempotencyKey).toBe('kunci-tetap-1')
  })
})

describe('batas waktu pada book', () => {
  test('TIDAK mengirim book kedua, melainkan bertanya dengan kuncinya', async () => {
    // Inti dari seluruh step ini. `book` kedua setelah timeout menghasilkan
    // pemesanan kedua: kamar kedua yang dibayar, tagihan yang harus
    // dikembalikan, dan dua surel konfirmasi ke pengguna yang sama.
    const world = harness({
      script: {
        book: [err(failure('SKY', 'book', 'timeout'))],
        lookup: [ok(booking('SKY', 'bkg_sudah_ada'))],
      },
    })

    const outcome = await confirmBooking(world.deps, PARAMS)

    expect(world.gateway.calls).toEqual(['book', 'findByKey'])
    expect(world.gateway.calls.filter((call) => call === 'book')).toHaveLength(1)
    expect(outcome.status).toBe('confirmed')
  })

  test('pemesanan yang ternyata sudah terbentuk diadopsi, tidak dibuat ganda', async () => {
    const world = harness({
      script: {
        book: [err(failure('SKY', 'book', 'timeout'))],
        lookup: [ok(booking('SKY', 'bkg_sudah_ada'))],
      },
    })

    const outcome = await confirmBooking(world.deps, PARAMS)

    expect(outcome.status).toBe('confirmed')
    if (outcome.status !== 'confirmed') return
    expect(outcome.adopted).toBe(true)
    expect(outcome.booking.bookingReference).toBe('bkg_sudah_ada')
  })

  test('baru mengulang book setelah supplier memastikan belum ada pemesanan', async () => {
    // not_found adalah satu-satunya jawaban yang membuat pengiriman ulang
    // `book` menjadi aman.
    const world = harness({
      script: {
        book: [err(failure('SKY', 'book', 'timeout')), ok(booking('SKY', 'bkg_baru'))],
        lookup: [err(failure('SKY', 'getBooking', 'not_found'))],
      },
    })

    const outcome = await confirmBooking(world.deps, PARAMS)

    expect(world.gateway.calls).toEqual(['book', 'findByKey', 'book'])
    expect(outcome.status).toBe('confirmed')
    if (outcome.status !== 'confirmed') return
    expect(outcome.booking.bookingReference).toBe('bkg_baru')
    expect(outcome.adopted).toBe(false)
  })

  test('bertanya pun gagal: keadaan dilaporkan tidak pasti, bukan ditebak', async () => {
    // Menebak "gagal" meninggalkan pemesanan hantu yang tetap ditagih.
    // Menebak "berhasil" menjanjikan kamar yang mungkin tidak ada.
    const world = harness({
      script: {
        book: [err(failure('SKY', 'book', 'timeout'))],
        lookup: [err(failure('SKY', 'getBooking', 'timeout'))],
      },
    })

    const outcome = await confirmBooking(world.deps, PARAMS)

    expect(outcome.status).toBe('uncertain')
    if (outcome.status !== 'uncertain') return
    expect(outcome.idempotencyKey).toBe('kunci-tetap-1')
    // Kegagalan yang dilaporkan adalah yang ASLI, bukan kegagalan saat
    // bertanya — yang pertama itulah yang menjelaskan kenapa tidak pasti.
    expect(outcome.error.operation).toBe('book')
    expect(world.gateway.calls.filter((call) => call === 'book')).toHaveLength(1)
  })

  test('kunci yang sama dipakai saat bertanya maupun saat mengulang', async () => {
    // Kunci yang berubah membuat seluruh mekanisme ini tidak berarti apa-apa.
    const world = harness({
      script: {
        book: [err(failure('SKY', 'book', 'timeout')), ok(booking('SKY', 'bkg_baru'))],
        lookup: [err(failure('SKY', 'getBooking', 'not_found'))],
      },
    })

    await confirmBooking(world.deps, PARAMS)

    const keys = new Set(world.log.entries.map((entry) => entry.idempotencyKey))
    expect([...keys]).toEqual(['kunci-tetap-1'])
  })
})

describe('kegagalan lain yang meninggalkan keadaan tidak diketahui', () => {
  test('500 juga memicu pertanyaan, bukan pengulangan buta', async () => {
    // 500 dapat berarti supplier gagal SETELAH menyimpan pemesanan.
    const world = harness({
      script: {
        book: [err(failure('SKY', 'book', 'upstream_error'))],
        lookup: [ok(booking('SKY', 'bkg_ada'))],
      },
    })

    const outcome = await confirmBooking(world.deps, PARAMS)

    expect(world.gateway.calls).toEqual(['book', 'findByKey'])
    expect(outcome.status).toBe('confirmed')
  })

  test('respons yang tidak dapat diurai juga dianggap tidak pasti', async () => {
    // Respons yang bentuknya berubah bisa saja merupakan konfirmasi.
    const world = harness({
      script: {
        book: [err(failure('SKY', 'book', 'invalid_response'))],
        lookup: [ok(booking('SKY', 'bkg_ada'))],
      },
    })

    const outcome = await confirmBooking(world.deps, PARAMS)

    expect(world.gateway.calls).toEqual(['book', 'findByKey'])
    expect(outcome.status).toBe('confirmed')
    if (outcome.status !== 'confirmed') return
    expect(outcome.adopted).toBe(true)
  })
})

describe('kegagalan yang jelas belum sampai ke supplier', () => {
  test('koneksi ditolak boleh langsung diulang tanpa bertanya', async () => {
    // Supplier PASTI belum menerima permintaannya, jadi tidak ada pemesanan
    // yang mungkin terbentuk dan tidak ada yang perlu ditanyakan.
    const world = harness({
      script: {
        book: [err(failure('SKY', 'book', 'unavailable')), ok(booking('SKY', 'bkg_1'))],
      },
    })

    const outcome = await confirmBooking(world.deps, PARAMS)

    expect(world.gateway.calls).toEqual(['book', 'book'])
    expect(outcome.status).toBe('confirmed')
  })

  test('kuota habis juga boleh langsung diulang', async () => {
    const world = harness({
      script: {
        book: [err(failure('SKY', 'book', 'rate_limited')), ok(booking('SKY', 'bkg_1'))],
      },
    })

    const outcome = await confirmBooking(world.deps, PARAMS)

    expect(world.gateway.calls).toEqual(['book', 'book'])
    expect(outcome.status).toBe('confirmed')
  })
})

describe('jawaban sah yang bukan keberhasilan', () => {
  test('kamar habis gagal seketika, tanpa bertanya dan tanpa mengulang', async () => {
    const world = harness({ script: { book: [err(failure('SKY', 'book', 'sold_out'))] } })

    const outcome = await confirmBooking(world.deps, PARAMS)

    expect(outcome.status).toBe('failed')
    expect(world.gateway.calls).toEqual(['book'])
  })

  test('hold yang kedaluwarsa juga gagal seketika', async () => {
    const world = harness({ script: { book: [err(failure('SKY', 'book', 'hold_expired'))] } })

    const outcome = await confirmBooking(world.deps, PARAMS)

    expect(outcome.status).toBe('failed')
    if (outcome.status !== 'failed') return
    expect(outcome.error.kind).toBe('hold_expired')
    expect(world.gateway.calls).toEqual(['book'])
  })
})

describe('batas percobaan', () => {
  test('berhenti setelah tiga pengiriman book, dan melaporkannya tidak pasti', async () => {
    // Gelung yang tidak berbatas akan terus menembak supplier selama ia
    // menjawab "koneksi ditolak" — yaitu selama supplier sedang tumbang.
    const world = harness({
      script: { book: [err(failure('SKY', 'book', 'unavailable'))] },
    })

    const outcome = await confirmBooking(world.deps, PARAMS)

    expect(world.gateway.calls.filter((call) => call === 'book')).toHaveLength(3)
    expect(outcome.status).toBe('uncertain')
  })
})

describe('jejak untuk rekonsiliasi', () => {
  test('setiap percobaan tercatat dengan nomornya sendiri', async () => {
    // Tanpa baris kedua, tidak ada cara mengetahui bahwa `book` pernah
    // kehabisan waktu sebelum akhirnya berhasil.
    const world = harness({
      script: {
        book: [err(failure('SKY', 'book', 'timeout')), ok(booking('SKY', 'bkg_baru'))],
        lookup: [err(failure('SKY', 'getBooking', 'not_found'))],
      },
    })

    await confirmBooking(world.deps, PARAMS)

    expect(world.log.entries.map((entry) => entry.operation)).toEqual([
      'book',
      'getBooking',
      'book',
    ])
    expect(world.log.entries[0]?.outcome).toBe('failure')
    expect(world.log.entries[0]?.errorKind).toBe('timeout')
  })

  test('nama tamu ikut tercatat tetapi kredensial tidak akan pernah', async () => {
    const world = harness({ script: { book: [ok(booking('SKY', 'bkg_1'))] } })

    await confirmBooking(world.deps, PARAMS)

    expect(world.log.entries[0]?.requestPayload).toEqual({
      holdRef: 'hld_1',
      guestName: 'Budi Santoso',
    })
  })
})
