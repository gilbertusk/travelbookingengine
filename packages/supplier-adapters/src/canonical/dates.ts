/**
 * Tanggal menginap adalah tanggal kalender, bukan titik waktu.
 *
 * CONVENTIONS.md bagian 10. Check-in 10 November berarti 10 November di
 * properti itu, apa pun zona waktu server, peramban, atau supplier. Setiap
 * fungsi di berkas ini bekerja dalam UTC secara eksplisit — tidak ada satu pun
 * yang memakai zona waktu mesin yang menjalankannya, karena kalau ada, hasil
 * pemesanan akan berbeda antara server di Jakarta dan server di Frankfurt.
 */

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const ORBIT_DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/

const SECONDS_PER_DAY = 86_400

export function isCalendarDate(value: string): boolean {
  return CALENDAR_DATE.test(value)
}

/**
 * Mengambil bagian tanggal dari titik waktu ISO, dalam UTC.
 *
 * NOVA mengirim tanggal menginap sebagai `2026-11-10T00:00:00Z`. Memotong
 * sepuluh karakter pertama kebetulan benar untuk bentuk itu dan salah begitu
 * supplier mengirim offset zona waktu — `2026-11-10T00:00:00+07:00` adalah
 * 9 November di UTC. Penguraian sungguhan menghilangkan pertanyaannya.
 */
export function calendarDateFromInstant(value: string): string | undefined {
  const epochMs = Date.parse(value)
  if (Number.isNaN(epochMs)) return undefined

  return new Date(epochMs).toISOString().slice(0, 10)
}

/**
 * LUNA mengirim tanggal sebagai epoch detik.
 *
 * Mengubahnya kembali dengan zona waktu lokal menggeser seluruh menginap satu
 * hari untuk sebagian zona, dan kesalahan itu tidak terlihat sampai ada yang
 * memesan di sekitar tengah malam.
 */
export function calendarDateFromEpochSeconds(seconds: number): string | undefined {
  if (!Number.isFinite(seconds)) return undefined

  const date = new Date(seconds * 1_000)
  if (Number.isNaN(date.getTime())) return undefined

  return date.toISOString().slice(0, 10)
}

export function epochSecondsFromCalendarDate(value: string): number | undefined {
  if (!isCalendarDate(value)) return undefined

  const epochMs = Date.parse(`${value}T00:00:00Z`)
  return Number.isNaN(epochMs) ? undefined : Math.floor(epochMs / 1_000)
}

/**
 * ORBIT memakai DD/MM/YYYY.
 *
 * Urutan hari-bulan, bukan bulan-hari. Parser yang mengasumsikan urutan
 * Amerika membaca 01/10/2026 sebagai 10 Januari, dan kesalahan itu hanya
 * terlihat pada tanggal di atas 12 — artinya lolos seluruh pengujian yang
 * kebetulan memakai tanggal kecil.
 */
export function calendarDateFromOrbit(value: string): string | undefined {
  const match = ORBIT_DATE.exec(value.trim())
  if (match === null) return undefined

  const [, day = '', month = '', year = ''] = match
  const candidate = `${year}-${month}-${day}`

  // Penyusunan string saja tidak menolak 31/02/2026. Tanggal yang tidak ada
  // harus ditolak di perbatasan, bukan menjadi 3 Maret di kemudian hari.
  return isRealDate(candidate) ? candidate : undefined
}

export function toOrbitDate(value: string): string | undefined {
  const match = CALENDAR_DATE.exec(value)
  if (match === null) return undefined

  const [, year = '', month = '', day = ''] = match
  return `${day}/${month}/${year}`
}

function isRealDate(value: string): boolean {
  const epochMs = Date.parse(`${value}T00:00:00Z`)
  if (Number.isNaN(epochMs)) return false

  return new Date(epochMs).toISOString().slice(0, 10) === value
}

/** Banyak malam antara dua tanggal kalender. Dipakai memeriksa kewajaran. */
export function nightsBetween(checkIn: string, checkOut: string): number | undefined {
  const from = epochSecondsFromCalendarDate(checkIn)
  const to = epochSecondsFromCalendarDate(checkOut)
  if (from === undefined || to === undefined) return undefined

  return (to - from) / SECONDS_PER_DAY
}
