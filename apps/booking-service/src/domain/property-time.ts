import type { LocalDate } from './stay-dates.js'

/**
 * Waktu di properti (Step 25).
 *
 * Tenggat pembatalan dihitung terhadap tanggal masuk DI ZONA WAKTU PROPERTI,
 * bukan zona pengguna, bukan zona server, dan bukan UTC (CONVENTIONS.md
 * bagian 9). Pemesan di Jakarta yang membatalkan hotel di Tokyo pukul 23.00 WIB
 * sudah berada pukul 01.00 di Tokyo — dan tenggat yang dihitung dengan jam
 * Jakarta akan meleset dua jam ke arah yang merugikan salah satu pihak.
 *
 * Tidak ada pustaka zona waktu: `Intl.DateTimeFormat` sudah membawa basis data
 * IANA bersama Node, dan satu fungsi di bawah adalah satu-satunya tempat
 * konversi itu dilakukan.
 */

const MS_PER_DAY = 86_400_000

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat | undefined {
  const cached = formatters.get(timeZone)
  if (cached !== undefined) return cached

  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatters.set(timeZone, formatter)

    return formatter
  } catch {
    // RangeError: zona yang tidak dikenal basis data IANA. Dijawab sebagai
    // "tidak dapat dihitung", bukan ditebak dengan zona lain.
    return undefined
  }
}

interface WallClock {
  readonly date: string
  /** Waktu dinding sebagai milidetik sejak epoch, seolah-olah UTC. */
  readonly asUtcMs: number
}

function wallClock(formatter: Intl.DateTimeFormat, instantMs: number): WallClock {
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(instantMs)).map((part) => [part.type, part.value]),
  )
  const field = (type: Intl.DateTimeFormatPartTypes): number => Number(parts[type])

  return {
    date: `${String(parts.year)}-${String(parts.month)}-${String(parts.day)}`,
    asUtcMs: Date.UTC(
      field('year'),
      field('month') - 1,
      field('day'),
      field('hour'),
      field('minute'),
      field('second'),
    ),
  }
}

/** Selisih zona terhadap UTC pada satu titik waktu, dalam milidetik. */
function offsetAt(formatter: Intl.DateTimeFormat, instantMs: number): number {
  return wallClock(formatter, instantMs).asUtcMs - instantMs
}

/**
 * Titik waktu pertama tanggal kalender `date` di zona `timeZone`.
 *
 * Biasanya tengah malam. Pada hari ketika jam maju TEPAT pukul 00.00 — Chile,
 * misalnya — tengah malam tidak pernah terjadi, dan hari itu dimulai pada saat
 * pergantian jam. `undefined` untuk zona yang tidak dikenal, dan untuk tanggal
 * yang tidak pernah terjadi di zona itu.
 *
 * Caranya: tengah malam yang dibaca seolah-olah UTC, dikurangi selisih zona
 * yang berlaku di sekitarnya — sehari sebelum, saat itu, dan sehari sesudah,
 * karena selisih yang benar adalah selisih pada titik yang belum diketahui.
 * Dari kandidat itu, yang sungguh jatuh pada tanggal yang diminta dan paling
 * awal adalah jawabannya.
 */
export function startOfLocalDate(date: LocalDate, timeZone: string): Date | undefined {
  const formatter = formatterFor(timeZone)
  if (formatter === undefined) return undefined

  const midnightAsUtc = Date.parse(`${date}T00:00:00Z`)
  const offsets = new Set(
    [-MS_PER_DAY, 0, MS_PER_DAY].map((shift) => offsetAt(formatter, midnightAsUtc + shift)),
  )
  const candidates = [...offsets]
    .map((offset) => midnightAsUtc - offset)
    .filter((instant) => wallClock(formatter, instant).date === date)

  // Tanggal yang tidak pernah terjadi di zona itu — Samoa melompati 30
  // Desember 2011 seluruhnya. Tidak ada awal hari untuk dihitung.
  if (candidates.length === 0) return undefined

  return new Date(Math.min(...candidates))
}
