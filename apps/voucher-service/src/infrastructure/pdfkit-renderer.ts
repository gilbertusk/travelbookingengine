import PDFDocument from 'pdfkit'
import QRCode from 'qrcode'
import type { VoucherRenderer } from '../application/ports.js'
import type { VoucherContent } from '../domain/voucher-content.js'

/**
 * E-voucher sebagai PDF A4, lewat PDFKit.
 *
 * Arah visual mengikuti DESIGN-SYSTEM.md: tenang, tipografi yang jelas, tanpa
 * hiasan. Dua keputusan yang lahir dari kenyataan bahwa voucher DICETAK:
 *
 * - **Hitam di atas putih saja.** Tidak ada warna aksen, tidak ada latar
 *   berwarna, tidak ada abu-abu terang untuk informasi penting. Printer kantor
 *   hitam-putih dan mesin fotokopi resepsionis tidak boleh menghilangkan apa
 *   pun. Abu-abu hanya untuk label, dan cukup gelap untuk tetap terbaca.
 * - **Fon bawaan PDF** (Times untuk judul, Helvetica untuk isi) — padanan
 *   serif-judul dan sans-isi di sistem desain tanpa menanam berkas fon.
 *
 * Teks tidak pernah diberi lebar tetap tanpa pembungkusan: setiap blok teks
 * memakai `width`, sehingga nama properti yang sangat panjang turun ke baris
 * berikutnya alih-alih terpotong di tepi kertas. Tata letak mengalir dari atas
 * ke bawah; posisi berikutnya selalu dihitung dari tinggi blok sebelumnya.
 */

const A4 = 'A4'
const MARGIN = 56
const PAGE_WIDTH = 595.28
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2
const QR_SIZE = 92
const QR_GAP = 20
const COLUMN_GAP = 24
const COLUMN_WIDTH = (CONTENT_WIDTH - COLUMN_GAP) / 2

const INK = '#000000'
/** Abu-abu label. Cukup gelap untuk fotokopi hitam-putih. */
const LABEL = '#444444'

const FONT = {
  display: 'Times-Roman',
  body: 'Helvetica',
  bold: 'Helvetica-Bold',
} as const

type Doc = PDFKit.PDFDocument

export function createPdfKitRenderer(): VoucherRenderer {
  return {
    async render(content) {
      return await renderVoucherPdf(content)
    },
  }
}

export interface RenderOptions {
  /** Hanya untuk uji: aliran isi tanpa kompresi dapat dibaca operator warnanya. */
  readonly compress?: boolean
}

export async function renderVoucherPdf(
  content: VoucherContent,
  options: RenderOptions = {},
): Promise<Uint8Array> {
  const doc = new PDFDocument({
    size: A4,
    margin: MARGIN,
    compress: options.compress ?? true,
    info: { Title: `E-voucher ${content.bookingReference}`, Author: 'Travel Booking Engine' },
  })
  const done = collect(doc)

  // Setiap bagian menerima posisi atasnya dan mengembalikan posisi sesudahnya.
  // Posisi tidak pernah ditulis ke dokumen; ia mengalir lewat nilai kembalian.
  const sections = [reference, stayDetails, priceTable, cancellation, contact, footer]
  sections.reduce((y, draw) => draw(doc, content, y), header(doc, content))

  doc.end()
  return await done
}

function collect(doc: Doc): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('end', () => {
      resolve(new Uint8Array(Buffer.concat(chunks)))
    })
    doc.on('error', reject)
  })
}

interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
}

/** Menulis teks di kotak dan mengembalikan tepi bawahnya. */
function write(doc: Doc, text: string, box: Box, options: PDFKit.Mixins.TextOptions = {}): number {
  doc.text(text, box.x, box.y, { width: box.width, ...options })
  return doc.y
}

function label(doc: Doc, text: string, box: Box): number {
  doc.font(FONT.body).fontSize(8).fillColor(LABEL)
  return write(doc, text.toUpperCase(), box, { characterSpacing: 0.6 })
}

function value(doc: Doc, text: string, box: Box): number {
  doc.font(FONT.body).fontSize(11).fillColor(INK)
  return write(doc, text, box)
}

function rule(doc: Doc, y: number, weight: number): void {
  doc
    .lineWidth(weight)
    .strokeColor(INK)
    .moveTo(MARGIN, y)
    .lineTo(PAGE_WIDTH - MARGIN, y)
    .stroke()
}

function header(doc: Doc, content: VoucherContent): number {
  const top = MARGIN
  const width = CONTENT_WIDTH - QR_SIZE - QR_GAP

  drawQr(doc, content.bookingReference, PAGE_WIDTH - MARGIN - QR_SIZE, top)

  const afterLabel = label(doc, 'E-voucher pemesanan', { x: MARGIN, y: top, width })
  doc.font(FONT.display).fontSize(24).fillColor(INK)
  const afterName = write(
    doc,
    content.property.name,
    { x: MARGIN, y: afterLabel + 6, width },
    {
      lineGap: 2,
    },
  )
  doc.font(FONT.body).fontSize(10).fillColor(INK)
  const afterAddress = write(doc, content.property.address, { x: MARGIN, y: afterName + 4, width })

  return Math.max(afterAddress, top + QR_SIZE) + 24
}

/**
 * Kode QR berisi booking reference supplier, digambar sebagai vektor.
 *
 * Vektor, bukan gambar raster: tetap tajam di cetakan mana pun, dan kotaknya
 * hitam pekat tanpa antialias yang membuat pemindai ragu pada fotokopi.
 */
function drawQr(doc: Doc, payload: string, x: number, y: number): void {
  const qr = QRCode.create(payload, { errorCorrectionLevel: 'M' })
  const { size, data } = qr.modules
  const quiet = 2
  const cell = QR_SIZE / (size + quiet * 2)

  doc.save().fillColor(INK)
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (data[row * size + col] === 1) {
        doc.rect(x + (col + quiet) * cell, y + (row + quiet) * cell, cell, cell)
      }
    }
  }
  doc.fill().restore()
}

function reference(doc: Doc, content: VoucherContent, top: number): number {
  rule(doc, top, 1.5)
  const box = { x: MARGIN, width: CONTENT_WIDTH }
  const afterLabel = label(doc, 'Kode pemesanan penyedia (booking reference)', {
    ...box,
    y: top + 12,
  })
  doc.font(FONT.bold).fontSize(22).fillColor(INK)
  const after = write(doc, content.bookingReference, { ...box, y: afterLabel + 4 }) + 10
  rule(doc, after, 1.5)

  return after + 20
}

type Pair = readonly [title: string, text: string]

/** Dua kolom; tinggi baris mengikuti kolom yang lebih tinggi. */
function pairRow(doc: Doc, top: number, left: Pair, right: Pair): number {
  const ends = [left, right].map(([title, text], index) => {
    const x = MARGIN + index * (COLUMN_WIDTH + COLUMN_GAP)
    const afterLabel = label(doc, title, { x, y: top, width: COLUMN_WIDTH })
    return value(doc, text, { x, y: afterLabel + 3, width: COLUMN_WIDTH })
  })

  return Math.max(...ends) + 14
}

function stayDetails(doc: Doc, content: VoucherContent, top: number): number {
  const { stay, guest } = content
  const rows: readonly (readonly [Pair, Pair])[] = [
    [
      ['Tanggal masuk', stay.checkIn],
      ['Tanggal keluar', stay.checkOut],
    ],
    [
      ['Jenis kamar', content.roomType],
      ['Rate plan', content.ratePlan],
    ],
    [
      ['Tamu utama', guest.name],
      ['Jumlah tamu dan durasi', `${guest.count}, ${stay.nights}`],
    ],
  ]

  return rows.reduce((y, [left, right]) => pairRow(doc, y, left, right), top)
}

const AMOUNT_WIDTH = 150
const LINE_LABEL_WIDTH = CONTENT_WIDTH - AMOUNT_WIDTH - 12

function priceTable(doc: Doc, content: VoucherContent, top: number): number {
  const afterLines = content.price.lines.reduce(
    (y, line) => priceLine(doc, y, { label: line.label, amount: line.amount, bold: false }),
    heading(doc, 'Rincian harga', top),
  )

  rule(doc, afterLines + 2, 0.75)
  const total = { label: 'Total dibayar', amount: content.price.total, bold: true }

  return priceLine(doc, afterLines + 8, total) + 14
}

interface Line {
  readonly label: string
  readonly amount: string
  readonly bold: boolean
}

function priceLine(doc: Doc, top: number, line: Line): number {
  doc
    .font(line.bold ? FONT.bold : FONT.body)
    .fontSize(line.bold ? 12 : 10.5)
    .fillColor(INK)
  const labelEnd = write(doc, line.label, { x: MARGIN, y: top, width: LINE_LABEL_WIDTH })
  const amountBox = { x: PAGE_WIDTH - MARGIN - AMOUNT_WIDTH, y: top, width: AMOUNT_WIDTH }
  const amountEnd = write(doc, line.amount, amountBox, { align: 'right' })

  return Math.max(labelEnd, amountEnd) + 4
}

function heading(doc: Doc, text: string, top: number): number {
  doc.font(FONT.display).fontSize(15).fillColor(INK)
  return write(doc, text, { x: MARGIN, y: top, width: CONTENT_WIDTH }) + 6
}

function section(doc: Doc, top: number, title: string, body: string): number {
  const afterHeading = heading(doc, title, top)
  doc.font(FONT.body).fontSize(10.5).fillColor(INK)
  const box = { x: MARGIN, y: afterHeading, width: CONTENT_WIDTH }

  return write(doc, body, box, { lineGap: 2 }) + 16
}

function cancellation(doc: Doc, content: VoucherContent, top: number): number {
  return section(doc, top, 'Kebijakan pembatalan', content.cancellationPolicy)
}

function contact(doc: Doc, content: VoucherContent, top: number): number {
  const { phone, email } = content.property
  return section(
    doc,
    top,
    'Kontak properti',
    `Telepon: ${phone}
Surel: ${email}`,
  )
}

function footer(doc: Doc, content: VoucherContent, top: number): number {
  doc
    .lineWidth(0.5)
    .strokeColor(LABEL)
    .moveTo(MARGIN, top)
    .lineTo(PAGE_WIDTH - MARGIN, top)
    .stroke()
  doc.font(FONT.body).fontSize(8.5).fillColor(LABEL)
  const text =
    'Tunjukkan voucher ini beserta kartu identitas tamu utama saat check-in. ' +
    `Diterbitkan ${content.issuedAt}. Nomor pemesanan internal: ${content.bookingId}.`

  return write(doc, text, { x: MARGIN, y: top + 8, width: CONTENT_WIDTH }, { lineGap: 1.5 })
}
