import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { expectedSignature, isValidSignature, type SignatureInput } from './signature.js'

/**
 * Kredensial di berkas uji ini adalah nilai contoh yang dibuat untuk uji, bukan
 * kunci Midtrans sungguhan. Server key sandbox yang asli tidak pernah masuk ke
 * kode maupun uji — ia dibaca dari env lewat config.ts (CONVENTIONS.md
 * bagian 12).
 */
const INPUT: SignatureInput = {
  orderId: 'ORDER-abc-1',
  statusCode: '200',
  grossAmount: '1250000.00',
  serverKey: 'SB-Mid-server-TESTKEY',
}

/**
 * Jawaban yang diketahui.
 *
 * Dihitung terpisah dari kode ini —
 * `sha512("ORDER-abc-1" + "200" + "1250000.00" + "SB-Mid-server-TESTKEY")` —
 * sehingga ia membekukan URUTAN penggabungannya, bukan hanya konsistensi fungsi
 * dengan dirinya sendiri. Menukar dua bahan mana pun mengubah nilai ini.
 */
const KNOWN_SIGNATURE =
  '2b54aae77630828341ac981d8461155dc9ad998928a78a49605a6a992b1758ba' +
  '133bf37dec32a3e92c871ef983075467575635f8bdda4cbf24140f9c72dc27b1'

describe('perhitungan tanda tangan', () => {
  test('menghasilkan SHA-512 heksadesimal dari empat bahan dengan urutan yang benar', () => {
    expect(expectedSignature(INPUT)).toBe(KNOWN_SIGNATURE)
  })

  test('panjangnya 128 karakter heksadesimal', () => {
    expect(expectedSignature(INPUT)).toMatch(/^[0-9a-f]{128}$/)
  })
})

describe('verifikasi', () => {
  test('tanda tangan yang sah diterima', () => {
    expect(isValidSignature(INPUT, KNOWN_SIGNATURE)).toBe(true)
  })

  test('tanda tangan yang tidak sah ditolak', () => {
    const tampered = KNOWN_SIGNATURE.replace(/^2/, '3')

    expect(isValidSignature(INPUT, tampered)).toBe(false)
  })

  /**
   * Keempat bahan diuji satu per satu. Bahan yang diam-diam tidak ikut
   * ditandatangani adalah bahan yang boleh diubah penyerang, dan yang paling
   * berbahaya di antaranya adalah gross_amount.
   */
  test.each([
    ['order_id', { orderId: 'ORDER-lain' }],
    ['status_code', { statusCode: '201' }],
    ['gross_amount', { grossAmount: '9250000.00' }],
    ['server_key', { serverKey: 'SB-Mid-server-KUNCI-LAIN' }],
  ])('%s yang diubah membatalkan tanda tangan', (_name, override) => {
    expect(isValidSignature({ ...INPUT, ...override }, KNOWN_SIGNATURE)).toBe(false)
  })

  test('tanda tangan yang lebih pendek ditolak tanpa melempar', () => {
    // timingSafeEqual melempar RangeError bila panjang buffer berbeda. Tanpa
    // penjagaan panjang, notifikasi dengan tanda tangan sepanjang satu karakter
    // akan meruntuhkan penangan webhook alih-alih ditolak.
    expect(() => isValidSignature(INPUT, 'a')).not.toThrow()
    expect(isValidSignature(INPUT, 'a')).toBe(false)
  })

  test('tanda tangan kosong ditolak', () => {
    expect(isValidSignature(INPUT, '')).toBe(false)
  })

  test('tanda tangan yang lebih panjang ditolak', () => {
    expect(isValidSignature(INPUT, `${KNOWN_SIGNATURE}00`)).toBe(false)
  })

  test('huruf besar pada tanda tangan ditolak', () => {
    // Midtrans mengirim heksadesimal huruf kecil. Menormalkan huruf besar akan
    // menerima bentuk yang penyedia tidak pernah kirim, tanpa manfaat apa pun.
    expect(isValidSignature(INPUT, KNOWN_SIGNATURE.toUpperCase())).toBe(false)
  })
})

/**
 * Penjagaan struktural.
 *
 * Perbandingan biasa dan perbandingan waktu tetap menghasilkan jawaban yang
 * SAMA untuk setiap masukan, jadi tidak ada uji perilaku yang dapat
 * membedakannya. Yang tersisa adalah memeriksa kodenya, dan itu dilakukan di
 * sini alih-alih dipercayakan pada ingatan peninjau.
 *
 * Ini bukti yang lebih lemah daripada uji perilaku, dan dicatat apa adanya
 * sebagai keterbatasan pada README service.
 */
describe('penjagaan struktural perbandingan waktu tetap', () => {
  const source = readFileSync(new URL('./signature.ts', import.meta.url), 'utf8')
  const code = source.replaceAll(/\/\*\*[\s\S]*?\*\//g, '').replaceAll(/\/\/.*$/gm, '')

  test('memakai PEMANGGILAN timingSafeEqual sebagai hasilnya, bukan hanya mengimpornya', () => {
    // Memeriksa impornya saja tidak cukup: mengganti pemanggilannya dengan `===`
    // sambil membiarkan impornya tetap ada akan lolos.
    expect(code).toMatch(/return timingSafeEqual\(/)
    expect(code).toMatch(/from 'node:crypto'/)
  })

  test('tidak ada perbandingan kesetaraan selain pada panjang buffer', () => {
    // Aturan yang sengaja kasar: di berkas ini, satu-satunya perbandingan yang
    // sah adalah perbandingan PANJANG. Apa pun yang lain — `===`, `!==`,
    // `startsWith`, `localeCompare` — berarti ada jalur yang lamanya bergantung
    // pada isi tanda tangan.
    //
    // Versi pertama uji ini mencari pola `expected === candidate` dan TIDAK
    // menangkap `expected.toString() === candidate.toString()`. Aturan yang
    // melarang seluruh perbandingan menangkap keduanya, dan tidak perlu menebak
    // bentuk penulisan berikutnya.
    const offending = code
      .split('\n')
      .filter((line) => !line.includes('.length') && /===|!==|[^=!<>]==[^=]|!=[^=]/.test(line))

    expect(offending).toEqual([])
  })

  test('tidak memakai localeCompare maupun startsWith pada tanda tangan', () => {
    expect(code).not.toContain('localeCompare')
    expect(code).not.toContain('startsWith')
  })
})
