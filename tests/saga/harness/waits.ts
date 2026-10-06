/**
 * Penantian dengan POLLING dan batas waktu — satu-satunya bentuk penantian di
 * rangkaian uji ini (Definisi Selesai Step 20).
 *
 * Penundaan tetap ("tunggu tiga detik lalu periksa") ditolak: terlalu pendek
 * membuatnya rapuh di mesin CI yang lambat, terlalu panjang membuat seluruh
 * rangkaian lamban, dan keduanya tidak pernah menjelaskan APA yang ditunggu
 * ketika gagal. `eventually` gagal dengan nama kondisinya dan, bila ada,
 * keadaan terakhir yang teramati.
 */

const POLL_INTERVAL_MS = 100

export async function eventually(
  label: string,
  condition: () => Promise<boolean> | boolean,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await condition()) return
    if (Date.now() >= deadline) {
      throw new Error(`tidak pernah terpenuhi dalam ${String(timeoutMs)} ms: ${label}`)
    }
    await pause(POLL_INTERVAL_MS)
  }
}

/**
 * Menunggu nilai yang memenuhi syarat, lalu MENGEMBALIKANNYA. Pesan galatnya
 * memuat nilai terakhir yang teramati — pada uji saga yang gagal, "masih PAID"
 * jauh lebih berguna daripada "tidak pernah CONFIRMED".
 */
export async function waitFor<T>(
  label: string,
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 30_000,
): Promise<T> {
  let last: T | undefined
  let found: T | undefined
  try {
    await eventually(
      label,
      async () => {
        last = await read()
        if (!accept(last)) return false
        found = last
        return true
      },
      timeoutMs,
    )
  } catch (error) {
    throw new Error(`${String(error)}\nnilai terakhir: ${JSON.stringify(last)}`, { cause: error })
  }
  if (found === undefined) throw new Error(`nilai tidak tersedia: ${label}`)
  return found
}

/**
 * Jeda polling. BUKAN penantian atas sesuatu — hanya jarak antar pemeriksaan
 * di dalam `eventually`. Tidak diekspor, supaya tidak dipakai sebagai
 * "tunggu sebentar" di uji.
 */
async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}
