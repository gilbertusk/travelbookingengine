import http from 'k6/http'
import { check } from 'k6'
import { GATEWAY_URL, SEARCH_TAGS } from './config.mjs'
import { toQuery } from './criteria.mjs'

/**
 * Satu permintaan pencarian, beserta pemeriksaan isinya.
 *
 * Kode status saja tidak cukup. Pencarian yang menjawab 200 dengan daftar
 * kosong adalah pencarian yang gagal, dan uji beban yang hanya memeriksa 200
 * akan melaporkan keberhasilan penuh terhadap sistem yang tidak mengembalikan
 * satu pun hotel. Itu kegagalan pengukuran yang paling mahal di seluruh
 * step ini, karena hasilnya masuk ke README sebagai bukti.
 */
export function search(criteria) {
  const response = http.get(`${GATEWAY_URL}/search?${toQuery(criteria)}`, {
    tags: SEARCH_TAGS,
  })

  const body = parse(response)

  check(response, {
    'status 200': (item) => item.status === 200,
    'ada hasilnya': () => (body?.data?.properties?.length ?? 0) > 0,
    // Harga jual, bukan harga supplier. Nilainya tidak diperiksa di sini —
    // yang diperiksa hanya bahwa bidangnya ada dan berbentuk uang, karena
    // kebenaran angkanya sudah dijaga 76 uji di pricing-service.
    'harga akhir ada': () => {
      const first = body?.data?.properties?.[0]

      return typeof first?.lowestTotal?.amountMinor === 'number'
    },
  })

  return { response, body }
}

/**
 * Sumber jawaban: cache atau langsung.
 *
 * Dibaca dari metadata respons, bukan ditebak dari latensinya. Menebak dari
 * latensi akan menghitung setiap jawaban cepat sebagai cache hit — termasuk
 * pencarian sungguhan yang kebetulan cepat karena seluruh supplier lagi
 * lancar.
 */
export function sourceOf(body) {
  return body?.data?.meta?.source ?? 'unknown'
}

/** Apakah hasilnya parsial — sebagian supplier belum berkontribusi. */
export function isPartial(body) {
  return body?.data?.meta?.partial === true
}

function parse(response) {
  try {
    return response.json()
  } catch {
    // Jawaban yang tidak dapat diurai tetap dihitung sebagai permintaan yang
    // gagal lewat `check` di atas; yang penting di sini adalah tidak
    // menghentikan iterasi VU karena satu jawaban rusak.
    return undefined
  }
}
