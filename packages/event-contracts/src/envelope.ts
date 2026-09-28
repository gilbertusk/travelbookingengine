import { getOrCreateCorrelationId, newCorrelationId } from '@tbe/shared-kernel'
import { z } from 'zod'

/**
 * Amplop yang sama untuk setiap pesan, baik peristiwa Kafka maupun perintah
 * RabbitMQ.
 *
 * Amplop dipisahkan dari isi karena yang berubah adalah isinya, bukan
 * pembungkusnya. Consumer dapat membaca correlationId, causationId, dan konteks
 * penelusuran tanpa tahu apa pun tentang jenis pesannya — dan itulah yang
 * membuat Step 06 dapat memulihkan trace di sisi consumer secara seragam.
 */

export const envelopeSchema = z.object({
  eventId: z.uuid(),
  eventType: z.string().min(1),
  /** Dinaikkan bila bentuk payload berubah tidak kompatibel. */
  eventVersion: z.number().int().positive(),
  occurredAt: z.iso.datetime(),
  correlationId: z.string().min(1),
  /**
   * eventId dari pesan yang menyebabkan pesan ini. Inilah yang membuat rantai
   * sebab-akibat sebuah saga dapat direkonstruksi dari log peristiwa saja.
   */
  causationId: z.uuid().optional(),
  /**
   * Konteks trace W3C. Tanpa ini penelusuran terputus tepat di titik paling
   * menarik: ketika alur berpindah dari HTTP ke saga asinkron.
   */
  traceparent: z.string().optional(),
})

export type Envelope = z.infer<typeof envelopeSchema>

export interface Message<TType extends string, TPayload> extends Envelope {
  readonly eventType: TType
  readonly payload: TPayload
}

/**
 * Nilai uang. Selalu membawa mata uangnya, selalu dalam satuan terkecil.
 *
 * CONVENTIONS.md bagian 9 melarang `number` untuk uang di dalam kode, tetapi
 * di atas kawat nilai harus berupa bilangan bulat satuan terkecil — bukan
 * desimal. Desimal yang melewati JSON adalah cara paling mudah kehilangan satu
 * sen tanpa ada yang menyadarinya.
 */
export const moneySchema = z.object({
  amountMinor: z.number().int(),
  currency: z.enum(['IDR', 'USD']),
})

export type Money = z.infer<typeof moneySchema>

export interface CreateMessageInput<TType extends string, TPayload> {
  readonly eventType: TType
  readonly payload: TPayload
  /**
   * Pengenal pesan yang SUDAH ditetapkan sebelumnya. Dipakai outbox (Step 19):
   * baris outbox yang diterbitkan ulang setelah penerbit mati di tengah jalan
   * harus membawa eventId yang SAMA, karena consumer menyaring duplikat lewat
   * nilai itu. eventId baru pada setiap percobaan mengubah "minimal sekali"
   * menjadi "berkali-kali tanpa dapat dikenali".
   */
  readonly eventId?: string
  readonly eventVersion?: number
  readonly causationId?: string
  readonly traceparent?: string
  readonly correlationId?: string
  readonly occurredAt?: string
}

/**
 * Membuat pesan lengkap dengan amplopnya.
 *
 * correlationId diambil otomatis dari konteks yang sedang berjalan, sehingga
 * pemanggil tidak pernah perlu meneruskannya. Penerusan manual adalah hal
 * pertama yang terlupa ketika sebuah alur bertambah satu lapis.
 */
export function createMessage<TType extends string, TPayload>(
  input: CreateMessageInput<TType, TPayload>,
): Message<TType, TPayload> {
  return {
    eventId: input.eventId ?? newCorrelationId(),
    eventType: input.eventType,
    eventVersion: input.eventVersion ?? 1,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    correlationId: input.correlationId ?? getOrCreateCorrelationId(),
    ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
    ...(input.traceparent === undefined ? {} : { traceparent: input.traceparent }),
    payload: input.payload,
  }
}

/** Membangun skema pesan lengkap dari skema payload-nya. */
export function messageSchema(eventType: string, payload: z.ZodType): z.ZodType {
  return envelopeSchema.extend({
    eventType: z.literal(eventType),
    payload,
  })
}
