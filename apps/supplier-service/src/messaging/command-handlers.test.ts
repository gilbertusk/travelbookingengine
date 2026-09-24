import { createLogger } from '@tbe/shared-kernel'
import { describe, expect, test } from 'vitest'
import { booking, err, failure, harness, ok } from '../testing/fakes.js'
import { handleCancel, handleConfirm } from './command-handlers.js'

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
  test('pemesanan berhasil tidak melempar apa pun', async () => {
    const world = harness({ script: { book: [ok(booking('SKY', 'bkg_1'))] } })

    await expect(
      handleConfirm({ resilience: world.deps, logger })(CONFIRM),
    ).resolves.toBeUndefined()
  })

  test('kunci idempotensi datang dari perintah, tidak dibuat ulang', async () => {
    // Perintah yang dikirim ulang RabbitMQ membawa kunci yang sama, dan
    // itulah yang membuat pengiriman ulang tidak menghasilkan pemesanan kedua.
    const world = harness({ script: { book: [ok(booking('SKY', 'bkg_1'))] } })

    await handleConfirm({ resilience: world.deps, logger })(CONFIRM)

    expect(world.log.entries[0]?.idempotencyKey).toBe('kunci-1')
  })

  test('status yang tidak pasti TIDAK dilempar', async () => {
    // Melempar berarti RabbitMQ mengirim ulang perintahnya, dan mengirim
    // ulang `book` dalam keadaan tidak pasti adalah yang harus dihindari.
    // Rekonsiliasi Step 28 yang menuntaskannya.
    const world = harness({
      script: {
        book: [err(failure('SKY', 'book', 'timeout'))],
        lookup: [err(failure('SKY', 'getBooking', 'timeout'))],
      },
    })

    await expect(
      handleConfirm({ resilience: world.deps, logger })(CONFIRM),
    ).resolves.toBeUndefined()
  })

  test('pemesanan yang diadopsi juga tidak dilempar', async () => {
    const world = harness({
      script: {
        book: [err(failure('SKY', 'book', 'timeout'))],
        lookup: [ok(booking('SKY', 'bkg_ada'))],
      },
    })

    await expect(
      handleConfirm({ resilience: world.deps, logger })(CONFIRM),
    ).resolves.toBeUndefined()
  })

  test('kamar habis dilempar supaya saga menjalankan kompensasinya', async () => {
    const world = harness({ script: { book: [err(failure('SKY', 'book', 'sold_out'))] } })

    await expect(handleConfirm({ resilience: world.deps, logger })(CONFIRM)).rejects.toThrow(
      /sold_out/,
    )
  })
})

describe('supplier.cancel', () => {
  test('pembatalan yang berhasil tidak melempar', async () => {
    const world = harness({ script: { cancel: [ok(undefined)] } })

    await expect(handleCancel({ resilience: world.deps, logger })(CANCEL)).resolves.toBeUndefined()
  })

  test('pemesanan yang sudah dibatalkan dianggap selesai', async () => {
    // Melemparnya akan membuat kompensasi diulang tanpa henti untuk sesuatu
    // yang sudah tercapai.
    const world = harness({
      script: { cancel: [err(failure('SKY', 'cancel', 'already_cancelled'))] },
    })

    await expect(handleCancel({ resilience: world.deps, logger })(CANCEL)).resolves.toBeUndefined()
  })

  test('pemesanan yang tidak ditemukan juga dianggap selesai', async () => {
    const world = harness({ script: { cancel: [err(failure('SKY', 'cancel', 'not_found'))] } })

    await expect(handleCancel({ resilience: world.deps, logger })(CANCEL)).resolves.toBeUndefined()
  })

  test('kegagalan sementara dilempar supaya perintahnya dikirim ulang', async () => {
    // Pembatalan aman diulang: membatalkan yang sudah dibatalkan menghasilkan
    // already_cancelled, bukan kerusakan.
    const world = harness({ script: { cancel: [err(failure('SKY', 'cancel', 'upstream_error'))] } })

    await expect(handleCancel({ resilience: world.deps, logger })(CANCEL)).rejects.toThrow(
      /upstream_error/,
    )
  })
})
