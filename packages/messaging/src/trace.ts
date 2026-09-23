import { currentTraceparent } from '@tbe/shared-kernel'

/**
 * Menyisipkan traceparent ke amplop pesan.
 *
 * Diambil otomatis dari trace yang sedang berjalan bila tidak diberikan
 * pemanggil. Tanpa ini, trace terputus tepat ketika alur berpindah dari HTTP
 * ke saga asinkron — dan itu justru bagian yang paling ingin dilihat.
 *
 * Field sengaja dihilangkan sepenuhnya bila tidak ada trace yang aktif, bukan
 * diisi string kosong: amplop dengan traceparent kosong akan lolos validasi
 * tetapi menghasilkan trace yatim di Jaeger.
 */
export function traceparentField(provided: string | undefined): Readonly<Record<string, string>> {
  const traceparent = provided ?? currentTraceparent()

  return traceparent === undefined ? {} : { traceparent }
}
