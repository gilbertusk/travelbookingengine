/**
 * Batas waktu hold yang dipakai sistem.
 *
 * Dua hold berjalan bersamaan: hold lokal di Redis dan hold di supplier.
 * Keduanya punya kedaluwarsa sendiri, dan yang dipakai adalah YANG LEBIH AWAL
 * (Step 17). Memakai yang lebih akhir berarti menerima pembayaran untuk kamar
 * yang supplier-nya sudah melepaskan hold — pembayaran berhasil, konfirmasi
 * supplier gagal, dan kompensasi harus berjalan untuk sesuatu yang seharusnya
 * tidak pernah terjadi.
 */
export function effectiveHoldUntil(localUntil: Date, supplierUntil: Date): Date {
  return supplierUntil.getTime() < localUntil.getTime() ? supplierUntil : localUntil
}
