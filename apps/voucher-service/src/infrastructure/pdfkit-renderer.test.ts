import QRCode from 'qrcode'
import { extractText, getDocumentProxy } from 'unpdf'
import { describe, expect, test } from 'vitest'
import { composeVoucher, type VoucherContent } from '../domain/voucher-content.js'
import { confirmedSource, PROPERTY } from '../testing/fakes.js'
import { createPdfKitRenderer, renderVoucherPdf } from './pdfkit-renderer.js'

/**
 * PDF voucher diperiksa dengan MENGEKSTRAK TEKSNYA, bukan dengan memeriksa
 * panggilan ke PDFKit. Yang dibuktikan adalah bahwa field wajib benar-benar
 * ada di halaman — teks yang tertimpa, terpotong di tepi, atau tergambar di
 * luar halaman tidak akan terbaca oleh ekstraksi, sama seperti tidak terbaca
 * oleh resepsionis.
 */

const ISSUED_AT = new Date('2026-10-07T03:00:04.000Z')

function content(overrides: Parameters<typeof confirmedSource>[0] = {}, property = PROPERTY) {
  const composed = composeVoucher(confirmedSource(overrides), property, ISSUED_AT)
  if (!composed.ok) throw new Error('persiapan gagal')
  return composed.value
}

/** Seluruh teks halaman, spasi dinormalkan — baris yang terbungkus menjadi satu spasi. */
async function textOf(pdf: Uint8Array): Promise<{ text: string; pages: number }> {
  const document = await getDocumentProxy(new Uint8Array(pdf))
  const { text, totalPages } = await extractText(document, { mergePages: true })

  return { text: normalize(text), pages: totalPages }
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function requiredFields(voucher: VoucherContent): readonly string[] {
  return [
    voucher.bookingReference,
    voucher.property.name,
    voucher.property.address,
    voucher.stay.checkIn,
    voucher.stay.checkOut,
    voucher.roomType,
    voucher.guest.name,
    voucher.guest.count,
    ...voucher.price.lines.flatMap((line) => [line.label, line.amount]),
    voucher.price.total,
    voucher.cancellationPolicy,
    voucher.property.phone,
    voucher.property.email,
  ].map(normalize)
}

describe('PDF voucher', () => {
  test('berisi seluruh field wajib — diperiksa dengan mengekstrak teks dari PDF', async () => {
    const voucher = content()

    const { text } = await textOf(await renderVoucherPdf(voucher))

    for (const field of requiredFields(voucher)) expect(text).toContain(field)
  })

  test('berukuran A4 dan muat satu halaman untuk pemesanan biasa', async () => {
    const pdf = await renderVoucherPdf(content())
    const document = await getDocumentProxy(new Uint8Array(pdf))
    const [, , width, height] = (await document.getPage(1)).view

    expect(document.numPages).toBe(1)
    // A4: 595,28 × 841,89 pt.
    expect(width).toBeCloseTo(595.28, 1)
    expect(height).toBeCloseTo(841.89, 1)
  })

  test('nama properti yang sangat panjang tidak membuat teks terpotong', async () => {
    const longName =
      'The Grand Royal Amarta Cendana Heritage Boutique Resort and Wellness Retreat ' +
      'Ubud Tegallalang Rice Terrace Panorama Collection by Harsa Hospitality Group ' +
      'Indonesia Signature Series Bali'
    const voucher = content({}, { ...PROPERTY, name: longName })

    const { text } = await textOf(await renderVoucherPdf(voucher))

    // Nama utuh, kata demi kata — dan field lain tetap ada sesudahnya, bukan
    // tertimpa judul yang memanjang ke bawah.
    expect(text).toContain(normalize(longName))
    for (const field of requiredFields(voucher)) expect(text).toContain(field)
  })

  test('rincian harga yang sangat panjang tidak menghilangkan bagian sesudahnya', async () => {
    const base = confirmedSource()
    const night = base.lines[0]
    if (night === undefined) throw new Error('persiapan gagal')
    const lines = Array.from({ length: 30 }, (_unused, index) => ({
      ...night,
      description: `Malam ke-${String(index + 1)}`,
    }))
    const voucher = content({ lines })

    const { text, pages } = await textOf(await renderVoucherPdf(voucher))

    expect(pages).toBeGreaterThanOrEqual(1)
    for (const field of requiredFields(voucher)) expect(text).toContain(field)
  })

  test('hanya memakai warna abu-abu — tetap terbaca dalam cetakan hitam putih', async () => {
    const pdf = await renderVoucherPdf(content(), { compress: false })
    const source = Buffer.from(pdf).toString('latin1')
    const colors = [...source.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) (rg|RG|scn|SCN)\b/g)]

    expect(colors.length).toBeGreaterThan(0)
    for (const [, red, green, blue] of colors) {
      expect(red).toBe(green)
      expect(green).toBe(blue)
    }
  })

  test('kode QR berisi booking reference supplier', async () => {
    // Kode QR digambar sebagai kotak vektor: jumlah kotak gelapnya sama dengan
    // jumlah modul gelap kode QR untuk booking reference itu — dan berbeda
    // untuk reference lain.
    const reference = 'SKY-BK-7F3A21'
    const pdf = await renderVoucherPdf(content({ supplierRef: reference }), { compress: false })
    const rects = (Buffer.from(pdf).toString('latin1').match(/ re\b/g) ?? []).length

    const darkModules = (ref: string) =>
      QRCode.create(ref, { errorCorrectionLevel: 'M' }).modules.data.filter((cell) => cell === 1)
        .length

    expect(rects).toBe(darkModules(reference))
    expect(darkModules('SKY-BK-LAIN')).not.toBe(darkModules(reference))
  })

  test('port renderer menghasilkan PDF', async () => {
    const pdf = await createPdfKitRenderer().render(content())

    expect(Buffer.from(pdf.subarray(0, 5)).toString('latin1')).toBe('%PDF-')
  })
})
