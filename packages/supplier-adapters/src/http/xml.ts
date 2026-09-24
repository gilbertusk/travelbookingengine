import { XMLParser } from 'fast-xml-parser'

/**
 * Pembacaan XML.
 *
 * Satu jebakan XML yang menjatuhkan hampir setiap integrasi pertama: elemen
 * berulang yang kebetulan hanya muncul sekali TIDAK menjadi larik. Satu hotel
 * dalam hasil pencarian datang sebagai objek; dua hotel datang sebagai larik.
 * Kode yang langsung memanggil `.map()` bekerja sempurna di lingkungan
 * pengembangan yang selalu punya banyak hasil, lalu gagal di produksi pada
 * pencarian yang hanya menemukan satu.
 *
 * [toArray] ada untuk itu, dan dipakai pada SETIAP daftar tanpa kecuali.
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Nilai numerik tidak diubah otomatis menjadi angka. Kode properti seperti
  // "0012" akan kehilangan nol di depannya, dan pengenal yang berubah diam-diam
  // adalah pengenal yang tidak cocok lagi dengan milik supplier.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
})

export type XmlNode = Record<string, unknown>

export function parseXml(source: string): XmlNode | undefined {
  try {
    const parsed: unknown = parser.parse(source)
    return isNode(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Isi `<Envelope><Body>…</Body></Envelope>`, atau undefined bila bukan SOAP. */
export function soapBody(document: XmlNode): XmlNode | undefined {
  const envelope = child(document, 'Envelope')
  if (envelope === undefined) return undefined

  return child(envelope, 'Body')
}

export function child(parent: XmlNode, name: string): XmlNode | undefined {
  const value = parent[name]
  return isNode(value) ? value : undefined
}

/**
 * Nilai teks sebuah elemen.
 *
 * Elemen dengan atribut diurai menjadi objek dengan kunci `#text`; elemen
 * polos menjadi string. Keduanya harus dibaca lewat fungsi yang sama, karena
 * penambahan satu atribut oleh supplier tidak boleh mengubah cara kita
 * membaca isinya.
 */
export function text(parent: XmlNode, name: string): string | undefined {
  const value = parent[name]

  if (typeof value === 'string') return value
  if (isNode(value) && typeof value['#text'] === 'string') return value['#text']

  return undefined
}

export function attribute(
  parent: XmlNode,
  name: string,
  attributeName: string,
): string | undefined {
  const value = parent[name]
  if (!isNode(value)) return undefined

  const found = value[`@_${attributeName}`]
  return typeof found === 'string' ? found : undefined
}

/**
 * Selalu larik, berapa pun jumlah elemennya.
 *
 * Elemen yang tidak ada menghasilkan larik kosong, bukan galat: daftar kosong
 * adalah jawaban yang sah, dan membedakannya dari "tidak ada elemennya sama
 * sekali" tidak berguna bagi pemanggil.
 */
export function toArray(value: unknown): readonly XmlNode[] {
  if (Array.isArray(value)) return value.filter(isNode)
  if (isNode(value)) return [value]

  return []
}

/** Daftar bernama di dalam pembungkusnya, mis. `<RoomList><Room/></RoomList>`. */
export function list(
  parent: XmlNode | undefined,
  wrapper: string,
  item: string,
): readonly XmlNode[] {
  if (parent === undefined) return []

  const container = child(parent, wrapper)
  return container === undefined ? [] : toArray(container[item])
}

export function isNode(value: unknown): value is XmlNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** ORBIT menyatakan boolean sebagai Y dan N. */
export function yesNo(value: string | undefined): boolean | undefined {
  if (value === 'Y') return true
  if (value === 'N') return false

  return undefined
}
