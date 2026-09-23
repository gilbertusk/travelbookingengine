/**
 * Hanya path internal yang diterima sebagai tujuan pengalihan.
 *
 * Nilainya datang dari parameter URL, jadi dikendalikan siapa pun yang membuat
 * tautannya. Tanpa pemeriksaan ini, `/masuk?lanjut=https://situs-palsu` akan
 * melempar pengguna ke situs lain tepat setelah ia berhasil masuk — momen
 * ketika ia paling siap memasukkan kredensial sekali lagi tanpa curiga.
 */
export function safeRedirect(target: string | null): string {
  if (target === null) return '/'
  if (!target.startsWith('/')) return '/'
  // '//situs-lain' mewarisi skema halaman sekarang dan tetap keluar dari
  // domain kita; '/\situs-lain' dinormalisasi peramban menjadi hal yang sama.
  if (target.startsWith('//') || target.startsWith('/\\')) return '/'

  return target
}
