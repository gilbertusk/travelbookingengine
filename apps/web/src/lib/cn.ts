import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Menggabungkan kelas Tailwind dengan yang terakhir menang.
 *
 * Tanpa twMerge, `cn('p-4', 'p-6')` menghasilkan kedua kelas dan yang berlaku
 * ditentukan urutan di berkas CSS — bukan urutan pemanggilan. Akibatnya prop
 * `className` pada komponen tidak dapat diandalkan untuk menimpa apa pun.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
