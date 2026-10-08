import { escapeHtml } from './format.js'

/**
 * Kerangka surel: satu model pesan, dua keluaran.
 *
 * Versi teks biasa dan HTML disusun dari model yang SAMA, sehingga keduanya
 * tidak dapat berbeda isi — dan tidak ada template yang bisa lupa punya versi
 * teks. Banyak klien surel memblokir HTML; versi teks bukan cadangan, ia
 * versi yang sama sahnya.
 *
 * HTML-nya sengaja polos: satu kolom, gaya sebaris, tanpa gambar. Klien surel
 * membuang <style>, memblokir gambar, dan merender tabel dengan cara masing-
 * masing; yang paling sederhana paling sedikit rusaknya.
 */

export const PRODUCT_NAME = 'Lintang'

export interface Fact {
  readonly label: string
  readonly value: string
}

export interface Message {
  readonly subject: string
  /**
   * Paragraf pembuka. Kalimat pertamanya adalah jawaban atas hal yang paling
   * dicemaskan penerimanya — biasanya uangnya.
   */
  readonly lead: string
  readonly paragraphs: readonly string[]
  readonly facts: readonly Fact[]
}

export interface Recipient {
  readonly name: string
  readonly bookingId: string
}

export interface Rendered {
  readonly text: string
  readonly html: string
}

const SIGN_OFF = `Salam,\nTim ${PRODUCT_NAME}`
const FOOTER =
  'Surel ini dikirim otomatis karena ada perubahan pada pemesananmu. ' +
  'Balas surel ini bila ada yang perlu ditanyakan.'

export function render(message: Message, recipient: Recipient): Rendered {
  const facts: readonly Fact[] = [
    { label: 'Nomor pemesanan', value: recipient.bookingId },
    ...message.facts,
  ]
  return {
    text: renderText(message, recipient, facts),
    html: renderHtml(message, recipient, facts),
  }
}

function renderText(message: Message, recipient: Recipient, facts: readonly Fact[]): string {
  return [
    `Halo ${recipient.name},`,
    message.lead,
    ...message.paragraphs,
    ['Rincian:', ...facts.map((fact) => `- ${fact.label}: ${fact.value}`)].join('\n'),
    SIGN_OFF,
    FOOTER,
  ].join('\n\n')
}

const COLOR = {
  text: '#1c2733',
  muted: '#5b6773',
  accent: '#1f6f80',
  rule: '#d9e0e6',
  panel: '#f3f6f8',
} as const

function renderHtml(message: Message, recipient: Recipient, facts: readonly Fact[]): string {
  const paragraph = (text: string): string =>
    `<p style="margin:0 0 16px;font-size:16px;line-height:1.55;color:${COLOR.text}">${escapeHtml(text)}</p>`

  const rows = facts
    .map(
      (fact) =>
        `<tr><td style="padding:6px 16px 6px 0;color:${COLOR.muted};font-size:14px;vertical-align:top;white-space:nowrap">${escapeHtml(fact.label)}</td>` +
        `<td style="padding:6px 0;color:${COLOR.text};font-size:14px;font-weight:600">${escapeHtml(fact.value)}</td></tr>`,
    )
    .join('')

  return `<!doctype html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(message.subject)}</title></head>
<body style="margin:0;padding:0;background:#ffffff;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="padding:0 0 24px;font-size:14px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${COLOR.accent}">${PRODUCT_NAME}</td></tr>
<tr><td>
${paragraph(`Halo ${recipient.name},`)}
<p style="margin:0 0 16px;font-size:18px;line-height:1.5;font-weight:600;color:${COLOR.text}">${escapeHtml(message.lead)}</p>
${message.paragraphs.map(paragraph).join('\n')}
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;padding:12px 16px;background:${COLOR.panel};border-radius:8px;width:100%">${rows}</table>
${paragraph('Salam,')}
<p style="margin:0 0 32px;font-size:16px;color:${COLOR.text}">Tim ${PRODUCT_NAME}</p>
<p style="margin:0;padding-top:16px;border-top:1px solid ${COLOR.rule};font-size:12px;line-height:1.5;color:${COLOR.muted}">${escapeHtml(FOOTER)}</p>
</td></tr></table>
</td></tr></table>
</body></html>`
}
