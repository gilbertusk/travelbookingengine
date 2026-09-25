import type {
  ClaimResult,
  WebhookClaim,
  WebhookLedger,
  WebhookOutcome,
} from '../application/ports.js'
import type { PrismaClient } from '../generated/prisma/client.js'

/**
 * Buku besar notifikasi di atas Postgres. Penegak idempotensi webhook (NFR-07).
 *
 * Seluruh mekanismenya satu baris SQL: `INSERT ... ON CONFLICT DO NOTHING` pada
 * kolom `provider_event_id` yang UNIK. Tidak ada `SELECT` sebelum `INSERT`, dan
 * ketiadaan itu adalah intinya — dua proses yang sama-sama bertanya "sudah ada?"
 * akan sama-sama dijawab "belum", lalu keduanya lanjut memproses. Yang melihat
 * kedua permintaan sekaligus hanya basis data.
 *
 * `createMany` dengan `skipDuplicates` dipakai untuk mendapatkan bentuk itu
 * tanpa SQL mentah: ia menerbitkan `ON CONFLICT DO NOTHING` dan mengembalikan
 * jumlah baris yang benar-benar masuk. `count === 0` berarti kita KALAH, dan
 * baru pada saat itu baris yang menang dibaca — pembacaan sesudah kalah, bukan
 * sebelum mencoba.
 *
 * Pembacaan hasil yang sudah tersimpan juga yang membuat notifikasi berulang
 * dapat dijawab tanpa efek samping apa pun.
 */
export function createPrismaWebhookLedger(prisma: PrismaClient): WebhookLedger {
  return {
    async claim(claim: WebhookClaim): Promise<ClaimResult> {
      const inserted = await prisma.webhookEvent.createMany({
        data: [
          {
            id: crypto.randomUUID(),
            providerEventId: claim.providerEventId,
            // Sudah diredaksi sebelum sampai di sini — lihat domain/redaction.ts.
            payload: asJsonValue(claim.payload),
          },
        ],
        skipDuplicates: true,
      })

      if (inserted.count === 1) return { kind: 'claimed' }

      const existing = await prisma.webhookEvent.findUnique({
        where: { providerEventId: claim.providerEventId },
        select: { outcome: true },
      })

      // Baris ada tetapi hasilnya belum tertulis: proses lain sedang
      // memprosesnya, atau proses sebelumnya mati di tengah. Bukan duplikat yang
      // sudah selesai — penyedia harus mengirimnya lagi.
      if (existing?.outcome == null) return { kind: 'in_progress' }

      return { kind: 'already_processed', outcome: existing.outcome }
    },

    async complete(
      providerEventId: string,
      outcome: WebhookOutcome,
      paymentId?: string,
    ): Promise<void> {
      await prisma.webhookEvent.update({
        where: { providerEventId },
        data: {
          outcome,
          processedAt: new Date(),
          ...(paymentId === undefined ? {} : { paymentId }),
        },
      })
    },
  }
}

/**
 * Menyiapkan payload untuk kolom `Json`.
 *
 * Perjalanan lewat `JSON.stringify` lalu `JSON.parse` membuang nilai yang tidak
 * dapat disimpan sebagai JSON — `undefined`, fungsi, `Date` menjadi string — dan
 * itu memang yang diinginkan: payload berasal dari badan permintaan HTTP, jadi ia
 * sudah JSON sejak awal. Yang dijaga di sini adalah tipenya, karena `JSON.parse`
 * mengembalikan `any` dan `any` yang merembet ke pemanggil adalah cara paling
 * mudah kehilangan seluruh pemeriksaan tipe di jalur ini.
 */
function asJsonValue(payload: unknown): object {
  if (payload === undefined) return {}

  const roundTripped: unknown = JSON.parse(JSON.stringify(payload))

  return typeof roundTripped === 'object' && roundTripped !== null ? roundTripped : {}
}
