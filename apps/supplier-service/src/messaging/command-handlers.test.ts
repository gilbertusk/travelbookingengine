import { createLogger } from '@tbe/shared-kernel'
import { describe, expect, test } from 'vitest'
import { createMessage } from '@tbe/event-contracts'
import {
  booking,
  err,
  failure,
  harness,
  ok,
  recordingReplies,
  type Script,
} from '../testing/fakes.js'
import {
  SupplierCancelRefused,
  SupplierConfirmRejected,
  handleCancel,
  handleCancelDeadLetter,
  handleConfirm,
  handleConfirmDeadLetter,
} from './command-handlers.js'

/**
 * Penangan perintah RabbitMQ.
 *
 * Yang dijaga di sini bukan logika bisnisnya — itu milik use case yang sama
 * dengan rute HTTP — melainkan cara melaporkan hasil. Melempar berarti
 * RabbitMQ mengirim ulang perintahnya, dan mengirim ulang `book` pada saat
 * yang salah adalah persis kerugian yang ingin dicegah.
 */

const logger = createLogger({ serviceName: 'supplier-service-test', level: 'silent' })

const CONFIRM = {
  bookingId: '0199e0a0-0000-7000-8000-000000000001',
  supplier: 'SKY' as const,
  holdRef: 'hld_1',
  guestName: 'Budi Santoso',
  idempotencyKey: 'kunci-1',
}

const CANCEL = {
  bookingId: '0199e0a0-0000-7000-8000-000000000001',
  supplier: 'SKY' as const,
  supplierRef: 'bkg_1',
}

describe('supplier.confirm', () => {
  function confirmWith(script: Script) {
    const world = harness({ script })
    const replies = recordingReplies()
    const deps = { resilience: world.deps, logger, replies }

    return {
      world,
      replies,
      handle: handleConfirm(deps),
      deadLetter: handleConfirmDeadLetter(deps),
    }
  }

  test('pemesanan berhasil diumumkan ke saga, bukan hanya dicatat', async () => {
    // Sebelum Step 19 hasil ini hanya masuk log, dan saga tidak pernah tahu
    // kamarnya sudah terjamin.
    const { handle, replies } = confirmWith({ book: [ok(booking('SKY', 'bkg_1'))] })

    await expect(handle(CONFIRM)).resolves.toBeUndefined()

    expect(replies.published).toEqual([
      {
        type: 'confirmed',
        bookingId: CONFIRM.bookingId,
        supplier: 'SKY',
        supplierRef: 'bkg_1',
        adopted: false,
      },
    ])
  })

  test('kunci idempotensi datang dari perintah, tidak dibuat ulang', async () => {
    // Perintah yang dikirim ulang RabbitMQ membawa kunci yang sama, dan
    // itulah yang membuat pengiriman ulang tidak menghasilkan pemesanan kedua.
    const { handle, world } = confirmWith({ book: [ok(booking('SKY', 'bkg_1'))] })

    await handle(CONFIRM)

    expect(world.log.entries[0]?.idempotencyKey).toBe('kunci-1')
  })

  /**
   * Uji wajib Step 19: "Timeout pada konfirmasi: getBooking dipanggil, bukan
   * konfirmasi ulang" (US-05). `book` yang kehabisan waktu diikuti PERTANYAAN
   * dengan kunci yang sama, dan pemesanan yang ternyata sudah ada diadopsi.
   */
  test('timeout pada konfirmasi: status ditanyakan, book tidak dikirim ulang', async () => {
    const { handle, world, replies } = confirmWith({
      book: [err(failure('SKY', 'book', 'timeout'))],
      lookup: [ok(booking('SKY', 'bkg_ada'))],
    })

    await handle(CONFIRM)

    expect(world.gateway.calls).toEqual(['book', 'findByKey'])
    expect(replies.published).toMatchObject([
      { type: 'confirmed', supplierRef: 'bkg_ada', adopted: true },
    ])
  })

  test('status yang tetap tidak pasti diumumkan uncertain dan TIDAK dilempar', async () => {
    // Melempar berarti RabbitMQ mengirim ulang perintahnya, dan mengirim ulang
    // `book` dalam keadaan tidak pasti adalah yang harus dihindari.
    const { handle, world, replies } = confirmWith({
      book: [err(failure('SKY', 'book', 'timeout'))],
      lookup: [err(failure('SKY', 'getBooking', 'timeout'))],
    })

    await expect(handle(CONFIRM)).resolves.toBeUndefined()

    expect(world.gateway.calls.filter((call) => call === 'book')).toHaveLength(1)
    expect(replies.published).toEqual([
      {
        type: 'uncertain',
        bookingId: CONFIRM.bookingId,
        supplier: 'SKY',
        idempotencyKey: 'kunci-1',
        reason: 'timeout',
      },
    ])
  })

  test('penolakan supplier dilempar supaya mengikuti jenjang percobaan, tanpa diumumkan dulu', async () => {
    const { handle, replies } = confirmWith({ book: [err(failure('SKY', 'book', 'sold_out'))] })

    await expect(handle(CONFIRM)).rejects.toBeInstanceOf(SupplierConfirmRejected)
    expect(replies.published).toEqual([])
  })

  test('jawaban yang gagal diumumkan dilempar, supaya perintahnya dicoba ulang', async () => {
    // Menelan kegagalan ini berarti saga menunggu jawaban yang tidak akan
    // pernah datang, untuk kamar yang SUDAH terjamin.
    const { handle, replies } = confirmWith({ book: [ok(booking('SKY', 'bkg_1'))] })
    replies.failNext()

    await expect(handle(CONFIRM)).rejects.toThrow(/kafka/)
  })

  test('percobaan ulang setelah pengumuman gagal mengadopsi pemesanan yang sama', async () => {
    // book idempoten terhadap kunci: percobaan kedua tidak membuat kamar kedua.
    const { handle, replies } = confirmWith({
      book: [ok(booking('SKY', 'bkg_1')), ok(booking('SKY', 'bkg_1'))],
    })
    replies.failNext()

    await expect(handle(CONFIRM)).rejects.toThrow(/kafka/)
    await handle(CONFIRM)

    expect(replies.published).toMatchObject([{ type: 'confirmed', supplierRef: 'bkg_1' }])
  })
})

describe('kabar dead letter supplier.confirm', () => {
  function deadLetterWith(error: unknown) {
    const replies = recordingReplies()
    const world = harness()
    const announce = handleConfirmDeadLetter({ resilience: world.deps, logger, replies })

    return {
      replies,
      run: async () => {
        await announce({
          payload: CONFIRM,
          message: createMessage({ eventType: 'supplier.confirm', payload: CONFIRM }),
          error,
          reason: 'exhausted',
        })
      },
    }
  }

  test('penolakan yang percobaannya habis diumumkan rejected, dengan jenisnya', async () => {
    const { replies, run } = deadLetterWith(new SupplierConfirmRejected('sold_out'))

    await run()

    expect(replies.published).toEqual([
      { type: 'rejected', bookingId: CONFIRM.bookingId, supplier: 'SKY', reason: 'sold_out' },
    ])
  })

  test('galat selain penolakan diumumkan uncertain, bukan rejected', async () => {
    // Kafka yang mati SETELAH book berhasil juga berakhir di dead letter.
    // Mengumumkannya sebagai penolakan membuat saga mengembalikan dana untuk
    // kamar yang sudah terjamin dan tetap harus dibayar.
    const { replies, run } = deadLetterWith(new Error('kafka tidak dapat dihubungi'))

    await run()

    expect(replies.published).toEqual([
      {
        type: 'uncertain',
        bookingId: CONFIRM.bookingId,
        supplier: 'SKY',
        idempotencyKey: 'kunci-1',
        reason: 'dead_letter:exhausted',
      },
    ])
  })
})

describe('supplier.cancel', () => {
  function cancelWith(script: Script) {
    const world = harness({ script })
    const cancelReplies = recordingReplies()
    const deps = { resilience: world.deps, logger, cancelReplies }

    return {
      cancelReplies,
      handle: handleCancel(deps),
      deadLetter: handleCancelDeadLetter(deps),
    }
  }

  const CANCELLED = {
    type: 'cancelled',
    bookingId: CANCEL.bookingId,
    supplier: 'SKY',
    supplierRef: 'bkg_1',
  }

  test('pembatalan yang berhasil diumumkan ke saga', async () => {
    // Pembatalan oleh pengguna (Step 25) menunggu jawaban ini sebelum
    // mengembalikan dana. Tanpa pengumuman, uangnya tidak pernah kembali.
    const { cancelReplies, handle } = cancelWith({ cancel: [ok(undefined)] })

    await expect(handle(CANCEL)).resolves.toBeUndefined()

    expect(cancelReplies.published).toEqual([CANCELLED])
  })

  test('pemesanan yang sudah dibatalkan dianggap selesai dan diumumkan', async () => {
    // Melemparnya akan membuat kompensasi diulang tanpa henti untuk sesuatu
    // yang sudah tercapai.
    const { cancelReplies, handle } = cancelWith({
      cancel: [err(failure('SKY', 'cancel', 'already_cancelled'))],
    })

    await expect(handle(CANCEL)).resolves.toBeUndefined()

    expect(cancelReplies.published).toEqual([CANCELLED])
  })

  test('pemesanan yang tidak ditemukan juga dianggap selesai', async () => {
    // Tidak ada pemesanan di supplier berarti tidak ada kamar yang tertahan:
    // mengembalikan dana tidak menimbulkan kerugian ganda.
    const { cancelReplies, handle } = cancelWith({
      cancel: [err(failure('SKY', 'cancel', 'not_found'))],
    })

    await expect(handle(CANCEL)).resolves.toBeUndefined()

    expect(cancelReplies.published).toEqual([CANCELLED])
  })

  test('kegagalan sementara dilempar supaya perintahnya dikirim ulang, tanpa pengumuman', async () => {
    // Pembatalan aman diulang: membatalkan yang sudah dibatalkan menghasilkan
    // already_cancelled, bukan kerusakan.
    const { cancelReplies, handle } = cancelWith({
      cancel: [err(failure('SKY', 'cancel', 'upstream_error'))],
    })

    await expect(handle(CANCEL)).rejects.toThrow(/upstream_error/)

    expect(cancelReplies.published).toEqual([])
  })

  test('pengumuman yang gagal terbit melempar, supaya pembatalan diulang dan diumumkan lagi', async () => {
    const { cancelReplies, handle } = cancelWith({ cancel: [ok(undefined), ok(undefined)] })
    cancelReplies.failNext()

    await expect(handle(CANCEL)).rejects.toThrow(/kafka/)
    await handle(CANCEL)

    expect(cancelReplies.published).toEqual([CANCELLED])
  })

  test('percobaan yang habis tanpa jawaban pasti diumumkan tidak pasti', async () => {
    // Batas waktu di setiap percobaan: pembatalannya mungkin sudah terjadi.
    const { cancelReplies, deadLetter } = cancelWith({})

    await deadLetter({
      payload: CANCEL,
      message: createMessage({ eventType: 'supplier.cancel', payload: CANCEL }),
      error: new Error('pembatalan gagal: timeout'),
      reason: 'exhausted',
    })

    expect(cancelReplies.published).toEqual([
      {
        type: 'cancel_failed',
        bookingId: CANCEL.bookingId,
        supplier: 'SKY',
        supplierRef: 'bkg_1',
        outcome: 'uncertain',
        reason: 'dead_letter:exhausted',
      },
    ])
  })

  test('penolakan supplier dilempar sebagai penolakan dan diumumkan pasti', async () => {
    // 409: supplier menjawab, dan jawabannya tidak.
    const { cancelReplies, handle, deadLetter } = cancelWith({
      cancel: [err({ supplier: 'SKY', operation: 'cancel', kind: 'upstream_error', status: 409 })],
    })

    const thrown = await handle(CANCEL).catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(SupplierCancelRefused)

    await deadLetter({
      payload: CANCEL,
      message: createMessage({ eventType: 'supplier.cancel', payload: CANCEL }),
      error: thrown,
      reason: 'exhausted',
    })

    expect(cancelReplies.published).toMatchObject([{ type: 'cancel_failed', outcome: 'refused' }])
  })
})
