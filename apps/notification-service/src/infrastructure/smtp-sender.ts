import type { ManagedResource } from '@tbe/shared-kernel'
import { createTransport } from 'nodemailer'
import type { EmailSender, SendResult } from '../application/ports.js'

/**
 * Pengirim surel lewat SMTP. Di pengembangan diarahkan ke Mailpit.
 *
 * Satu-satunya keputusan di berkas ini adalah membaca kode balasan SMTP:
 * mana yang permanen, mana yang sementara. Apa yang dilakukan dengan
 * keduanya diputuskan penghantar (application/deliver.ts).
 */

/** Bagian nodemailer yang dipakai — supaya pemetaan hasil dapat diuji tanpa server. */
export interface MailTransport {
  sendMail(options: {
    readonly from: string
    readonly to: string
    readonly subject: string
    readonly text: string
    readonly html: string
    readonly attachments: readonly {
      readonly filename: string
      readonly contentType: string
      readonly content: Buffer
    }[]
  }): Promise<unknown>
}

export function createSmtpSender(transport: MailTransport, from: string): EmailSender {
  return {
    async send(email): Promise<SendResult> {
      try {
        await transport.sendMail({
          from,
          to: email.to,
          subject: email.subject,
          text: email.text,
          html: email.html,
          attachments: email.attachments.map((attachment) => ({
            filename: attachment.filename,
            contentType: attachment.contentType,
            content: Buffer.from(attachment.content),
          })),
        })
        return { kind: 'sent' }
      } catch (error) {
        return classifySmtpError(error)
      }
    },
  }
}

/**
 * Balasan yang berarti PENERIMA ini tidak ada atau tidak dapat dikirimi:
 * 550 (kotak surat tidak ada), 551 (bukan pengguna lokal), 552 (kotak surat
 * penuh secara permanen), 553 (nama kotak surat tidak sah).
 */
const RECIPIENT_REJECTIONS = new Set([550, 551, 552, 553])

/**
 * Status tambahan 5.7.x adalah kebijakan: IP pengirim di daftar hitam,
 * SPF/DKIM gagal, relay ditolak. Itu salah kita, bukan salah penerima —
 * dan berlaku untuk SETIAP surel, termasuk surel kegagalan dan refund.
 */
const POLICY_STATUS = /(^|\s)5\.7\.\d+/

/**
 * Hanya penolakan PENERIMA yang permanen. Segala 5xx lain — autentikasi
 * (530/535), kebijakan (5.7.x), MAIL FROM ditolak, 554 umum — adalah salah
 * konfigurasi atau keadaan server kita: dicoba lagi, lalu dead letter beserta
 * peringatannya. Menandainya permanen berarti membuang surel setiap pengguna
 * sampai seseorang memperbaiki konfigurasi tanpa ada yang tahu.
 *
 * Kode yang dikembalikan disimpan di basis data, jadi hanya angka balasan atau
 * kode galat nodemailer — tidak pernah teks balasannya, yang sering menyebut
 * alamat penerima.
 */
export function classifySmtpError(error: unknown): SendResult {
  const responseCode = fieldOf(error, 'responseCode')
  const code = fieldOf(error, 'code')

  if (typeof responseCode === 'number') {
    const kind = isRecipientRejection(error, responseCode) ? 'permanent' : 'transient'
    return { kind, code: `smtp_${String(responseCode)}` }
  }

  // Amplop ditolak sebelum server sempat menjawab: alamatnya sendiri tidak
  // dapat diurai. Menunggu tidak akan membuatnya dapat diurai.
  if (code === 'EENVELOPE') return { kind: 'permanent', code: 'smtp_envelope' }

  return {
    kind: 'transient',
    code: typeof code === 'string' ? `smtp_${code.toLowerCase()}` : 'smtp_unknown',
  }
}

function isRecipientRejection(error: unknown, responseCode: number): boolean {
  const command = fieldOf(error, 'command')
  const response = fieldOf(error, 'response')
  // nodemailer menandai penolakan seluruh penerima dengan command 'RCPT TO'.
  // EENVELOPE tanpa command dianggap sama; EENVELOPE pada 'MAIL FROM' berarti
  // PENGIRIM kita yang ditolak.
  const isAtRecipient =
    command === 'RCPT TO' || (command === undefined && fieldOf(error, 'code') === 'EENVELOPE')
  const isPolicy = typeof response === 'string' && POLICY_STATUS.test(response)

  return isAtRecipient && RECIPIENT_REJECTIONS.has(responseCode) && !isPolicy
}

function fieldOf(error: unknown, field: string): unknown {
  return typeof error === 'object' && error !== null ? Reflect.get(error, field) : undefined
}

export interface SmtpOptions {
  readonly host: string
  readonly port: number
  readonly secure: boolean
  readonly user: string | undefined
  readonly password: string | undefined
  readonly timeoutMs: number
}

/** Transport nodemailer sungguhan, beserta sumber daya terkelolanya. */
export function createSmtpTransport(options: SmtpOptions): {
  readonly transport: MailTransport
  readonly resource: ManagedResource
} {
  const transporter = createTransport({
    host: options.host,
    port: options.port,
    secure: options.secure,
    ...(options.user === undefined
      ? {}
      : { auth: { user: options.user, pass: options.password ?? '' } }),
    connectionTimeout: options.timeoutMs,
    greetingTimeout: options.timeoutMs,
    socketTimeout: options.timeoutMs,
  })

  return {
    transport: {
      async sendMail(mail) {
        return await transporter.sendMail({ ...mail, attachments: [...mail.attachments] })
      },
    },
    resource: {
      name: 'smtp',
      // Tidak memeriksa server saat menyala: SMTP yang mati tidak boleh
      // mencegah service ini mencatat pemberitahuan (NFR-05). Penghantar yang
      // gagal mengirim mencoba lagi, dan /health/ready tidak bergantung padanya.
      start: async () => {
        await Promise.resolve()
      },
      stop: async () => {
        transporter.close()
        await Promise.resolve()
      },
    },
  }
}
