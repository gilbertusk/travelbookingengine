/**
 * Serializer XML kecil untuk ORBIT.
 *
 * Ditulis sendiri alih-alih memakai XMLBuilder dari fast-xml-parser, yang
 * sudah ditandai deprecated. Bentuk keluaran yang dibutuhkan sangat terbatas
 * dan sepenuhnya kita kendalikan, dan hasilnya diurai kembali oleh XMLParser
 * di dalam pengujian — jadi kebenarannya terverifikasi, bukan diasumsikan.
 */

export type XmlValue = string | number | boolean | null | undefined | XmlObject | XmlValue[]
export interface XmlObject {
  readonly [key: string]: XmlValue
}

const ATTRIBUTE_PREFIX = '@_'
const TEXT_KEY = '#text'

export function buildXml(root: XmlObject): string {
  return `<?xml version="1.0" encoding="UTF-8"?>${serializeObject(root)}`
}

function serializeObject(node: XmlObject): string {
  return Object.entries(node)
    .filter(([key]) => !key.startsWith(ATTRIBUTE_PREFIX) && key !== TEXT_KEY)
    .map(([key, value]) => serializeEntry(key, value))
    .join('')
}

function serializeEntry(tag: string, value: XmlValue): string {
  if (value === null || value === undefined) return `<${tag}/>`
  if (Array.isArray(value)) return value.map((item) => serializeEntry(tag, item)).join('')

  if (typeof value === 'object') {
    return `<${tag}${attributesOf(value)}>${innerOf(value)}</${tag}>`
  }

  return `<${tag}>${escapeXml(String(value))}</${tag}>`
}

function attributesOf(node: XmlObject): string {
  return Object.entries(node)
    .filter(([key]) => key.startsWith(ATTRIBUTE_PREFIX))
    .map(([key, value]) => ` ${key.slice(ATTRIBUTE_PREFIX.length)}="${escapeXml(scalar(value))}"`)
    .join('')
}

function innerOf(node: XmlObject): string {
  const text = node[TEXT_KEY]
  const children = serializeObject(node)

  return text === undefined || text === null ? children : `${escapeXml(scalar(text))}${children}`
}

/**
 * Hanya nilai skalar yang boleh menjadi teks atau atribut. Objek yang lolos ke
 * sini akan tertulis sebagai '[object Object]' di dalam XML — kerusakan senyap
 * yang jauh lebih sulit dilacak daripada galat saat menulisnya.
 */
function scalar(value: XmlValue): string {
  if (typeof value === 'object') {
    throw new TypeError('nilai atribut atau teks XML harus skalar')
  }

  return String(value)
}

export function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
