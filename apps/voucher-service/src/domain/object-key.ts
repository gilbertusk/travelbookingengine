/**
 * Kunci objek voucher di penyimpanan.
 *
 * Kunci TIDAK BOLEH dapat ditebak. bookingId mentah — atau apa pun yang
 * diturunkan darinya — membuat siapa pun yang mengetahui satu bookingId dapat
 * menyusun lokasi voucher itu, dan bookingId muncul di URL, di log proxy, dan
 * di tangkapan layar. Kunci di sini adalah token acak 256-bit; tidak ada
 * hubungan yang dapat dihitung antara kunci dan pemesanannya. Hubungan itu
 * hanya tersimpan di basis data voucher-service.
 *
 * Ketidaktahuan kunci tetap BUKAN satu-satunya penjaga. Endpoint unduhan
 * memeriksa kepemilikan sebelum menandatangani URL — lihat voucher-access.ts.
 */

/** 32 bita acak dalam base64url: 43 karakter tanpa padding. */
export const OBJECT_TOKEN_LENGTH = 43

const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/

export const OBJECT_KEY_PREFIX = 'v/'

export function voucherObjectKey(token: string): string {
  if (token.length < OBJECT_TOKEN_LENGTH || !TOKEN_PATTERN.test(token)) {
    // Token pendek atau berkarakter asing adalah cacat program di pembuat
    // token, bukan masukan pengguna. Lebih baik voucher gagal terbit daripada
    // terbit di kunci yang dapat ditebak.
    throw new Error('token kunci objek voucher terlalu lemah')
  }

  return `${OBJECT_KEY_PREFIX}${token}.pdf`
}
