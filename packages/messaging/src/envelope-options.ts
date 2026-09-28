/**
 * Bidang amplop yang boleh ditetapkan pemanggil, sama untuk peristiwa dan
 * perintah.
 *
 * `eventId`, `occurredAt`, dan `correlationId` ditambahkan Step 19 untuk
 * penerbit outbox. Pesan outbox dicatat di transaksi bisnis dan dikirim
 * belakangan, mungkin lebih dari sekali:
 *
 * - `eventId` harus SAMA pada setiap pengiriman ulang. Consumer menyaring
 *   duplikat lewat nilai itu; nilai baru pada setiap percobaan membuat
 *   duplikatnya tidak dapat dikenali.
 * - `occurredAt` adalah waktu perubahan keadaan, bukan waktu penerbit sempat
 *   mengirimnya. payment-service memilih nilai tagihan TERAKHIR menurut nilai
 *   itu, dan penerbit yang tertinggal lima menit tidak boleh mengubah urutan
 *   perubahan harga.
 * - `correlationId` adalah milik permintaan yang menyebabkan perubahan, bukan
 *   milik putaran penerbit yang kebetulan mengirimnya.
 */
export interface EnvelopeOptions {
  readonly causationId?: string
  readonly traceparent?: string
  readonly eventId?: string
  readonly occurredAt?: string
  readonly correlationId?: string
}

/**
 * Bidang amplop yang diberikan pemanggil, tanpa traceparent (yang punya
 * aturannya sendiri di trace.ts). Yang tidak diberikan dihilangkan sepenuhnya
 * — bukan diisi `undefined` — supaya createMessage mengisi nilai bawaannya.
 */
export function envelopeOverrides(
  options: EnvelopeOptions | undefined,
): Readonly<Record<string, string>> {
  const fields = {
    causationId: options?.causationId,
    eventId: options?.eventId,
    occurredAt: options?.occurredAt,
    correlationId: options?.correlationId,
  }

  return Object.fromEntries(
    Object.entries(fields).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}
