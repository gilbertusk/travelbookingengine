import { describe, expect, test } from 'vitest'
import type { OutgoingEmail } from '../application/ports.js'
import { classifySmtpError, createSmtpSender, type MailTransport } from './smtp-sender.js'

function smtpError(fields: {
  code?: string
  responseCode?: number
  response?: string
  command?: string
}): Error {
  return Object.assign(new Error('gagal'), fields)
}

const EMAIL: OutgoingEmail = {
  to: 'sari@example.com',
  subject: 'Pemesananmu terkonfirmasi',
  text: 'teks',
  html: '<p>teks</p>',
  attachments: [
    { filename: 'e-voucher.pdf', contentType: 'application/pdf', content: new Uint8Array([1, 2]) },
  ],
}

describe('klasifikasi galat SMTP', () => {
  test.each([550, 551, 552, 553])('penolakan penerima %i saat RCPT TO permanen', (responseCode) => {
    expect(classifySmtpError(smtpError({ code: 'EENVELOPE', responseCode }))).toEqual({
      kind: 'permanent',
      code: `smtp_${String(responseCode)}`,
    })
  })

  test.each([421, 450, 451, 452])('balasan %i (sementara) dicoba lagi', (responseCode) => {
    expect(classifySmtpError(smtpError({ responseCode }))).toEqual({
      kind: 'transient',
      code: `smtp_${String(responseCode)}`,
    })
  })

  test.each([530, 535])(
    'balasan %i adalah salah konfigurasi kita, bukan salah penerima: dicoba lagi lalu dead letter',
    (responseCode) => {
      expect(classifySmtpError(smtpError({ code: 'EAUTH', responseCode })).kind).toBe('transient')
    },
  )

  test('550 dengan status kebijakan 5.7.x (IP di daftar hitam) bukan salah penerima', () => {
    const error = smtpError({
      code: 'EENVELOPE',
      responseCode: 550,
      response: '550 5.7.1 Service unavailable; client host blocked',
    })

    expect(classifySmtpError(error).kind).toBe('transient')
  })

  test('5xx untuk MAIL FROM (pengirim kita ditolak) bukan salah penerima', () => {
    expect(
      classifySmtpError(smtpError({ code: 'EENVELOPE', responseCode: 553, command: 'MAIL FROM' }))
        .kind,
    ).toBe('transient')
  })

  test('554 umum sesudah DATA tidak dianggap penolakan penerima', () => {
    expect(
      classifySmtpError(smtpError({ code: 'EMESSAGE', responseCode: 554, command: 'DATA' })).kind,
    ).toBe('transient')
  })

  test('amplop tanpa balasan server (alamat tidak dapat diurai) permanen', () => {
    expect(classifySmtpError(smtpError({ code: 'EENVELOPE' }))).toEqual({
      kind: 'permanent',
      code: 'smtp_envelope',
    })
  })

  test.each(['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS'])(
    '%s adalah gangguan jaringan',
    (code) => {
      expect(classifySmtpError(smtpError({ code }))).toEqual({
        kind: 'transient',
        code: `smtp_${code.toLowerCase()}`,
      })
    },
  )

  test('galat yang tidak dikenal dianggap sementara', () => {
    expect(classifySmtpError('aneh')).toEqual({ kind: 'transient', code: 'smtp_unknown' })
  })

  test('kode tidak pernah memuat isi balasan server, yang sering menyebut alamat penerima', () => {
    const result = classifySmtpError(
      smtpError({
        code: 'EENVELOPE',
        responseCode: 550,
        response: '550 <sari@example.com> no such user',
      }),
    )

    expect(JSON.stringify(result)).not.toContain('sari')
  })
})

describe('pengirim SMTP', () => {
  function transport(outcome: 'ok' | Error) {
    const calls: unknown[] = []
    const fake: MailTransport = {
      async sendMail(options) {
        calls.push(options)
        if (outcome !== 'ok') throw outcome
        return await Promise.resolve({ messageId: '<1@test>' })
      },
    }
    return { fake, calls }
  }

  test('menyusun surel dengan versi teks, HTML, dan lampiran', async () => {
    const { fake, calls } = transport('ok')

    const result = await createSmtpSender(fake, 'Lintang <bantuan@lintang.test>').send(EMAIL)

    expect(result).toEqual({ kind: 'sent' })
    expect(calls).toEqual([
      {
        from: 'Lintang <bantuan@lintang.test>',
        to: 'sari@example.com',
        subject: 'Pemesananmu terkonfirmasi',
        text: 'teks',
        html: '<p>teks</p>',
        attachments: [
          {
            filename: 'e-voucher.pdf',
            contentType: 'application/pdf',
            content: Buffer.from([1, 2]),
          },
        ],
      },
    ])
  })

  test('penolakan server dijawab sebagai nilai, tidak dilempar', async () => {
    const { fake } = transport(smtpError({ code: 'EENVELOPE', responseCode: 550 }))

    await expect(createSmtpSender(fake, 'x@lintang.test').send(EMAIL)).resolves.toEqual({
      kind: 'permanent',
      code: 'smtp_550',
    })
  })
})
