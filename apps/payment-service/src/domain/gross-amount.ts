import { EXPONENT, money, type Currency, type Money } from '@tbe/money'

/**
 * Penguraian `gross_amount` dari Midtrans.
 *
 * Penyedia mengirimkannya sebagai string desimal — `"1250000.00"` — dan di
 * situlah pecahan biner paling mudah menyelinap masuk ke sistem yang seluruh
 * sisanya memakai bilangan bulat. `Number("1250000.00") * 100` sudah cukup
 * untuk menghasilkan 125000000.00000001 pada nilai tertentu, dan selisih satu
 * satuan terkecil pada nilai yang ditagih adalah selisih yang harus dijelaskan
 * kepada pengguna.
 *
 * Karena itu penguraiannya dilakukan atas DIGIT, bukan atas hasil `Number` dari
 * keseluruhan string: bagian bulat dan bagian pecahan digabung sebagai teks
 * lebih dulu, dan baru angka bulat hasilnya yang diubah menjadi bilangan.
 *
 * `Number.parseFloat` dan `Number` juga terlalu longgar untuk data dari luar:
 * keduanya menerima `"1e5"`, `"0x10"`, `" 12 "`, dan `"12abc"` — sebagian
 * dengan nilai yang sama sekali berbeda dari yang terlihat. Regex di bawah
 * menolak seluruhnya.
 */

/**
 * Bagian bulat dibatasi 15 digit dan pecahan 9 digit. Batas atasnya menjaga
 * hasilnya tetap berada di dalam bilangan bulat aman JavaScript; pemeriksaan
 * akhir tetap dilakukan, karena batas digit saja tidak menjaminnya.
 */
const DECIMAL_PATTERN = /^(\d{1,15})(?:\.(\d{1,9}))?$/

/**
 * Mengurai nilai penyedia menjadi Money.
 *
 * Mengembalikan undefined alih-alih melempar: nilai yang cacat adalah DATA yang
 * salah dari luar, bukan kerusakan sistem, dan pemanggil yang harus memutuskan
 * apa artinya — pola yang sama dengan `fromJson` di @tbe/money.
 */
export function parseGrossAmount(raw: string, currency: Currency): Money | undefined {
  const match = DECIMAL_PATTERN.exec(raw)

  if (match === null) return undefined

  const whole = match[1] ?? ''
  const fraction = match[2] ?? ''
  const exponent = EXPONENT[currency]

  const kept = fraction.slice(0, exponent)
  const dropped = fraction.slice(exponent)

  /**
   * Pecahan di luar eksponen mata uangnya hanya diterima bila seluruhnya nol.
   *
   * IDR bereksponen 0, jadi `"1250000.00"` sah dan bernilai 1.250.000 rupiah,
   * sementara `"1250000.50"` TIDAK sah — tidak ada setengah rupiah, dan
   * membulatkannya diam-diam berarti menagih nilai yang berbeda dari yang
   * dikirim penyedia. Yang benar adalah menolak, supaya selisihnya terlihat.
   */
  if (/[^0]/.test(dropped)) return undefined

  const minorDigits = `${whole}${kept.padEnd(exponent, '0')}`
  const parsed = Number(minorDigits)

  if (!Number.isSafeInteger(parsed)) return undefined

  return money(parsed, currency)
}
