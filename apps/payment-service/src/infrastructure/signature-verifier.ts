import type { NotificationSignature, SignatureVerifier } from '../application/ports.js'
import { isValidSignature } from '../domain/signature.js'

/**
 * Mengikat server key ke verifikasi tanda tangan.
 *
 * Hanya itu tugasnya, dan itu yang membuatnya ada: keputusan keamanannya hidup di
 * domain/signature.ts, sementara KUNCINYA dibaca config.ts dari env. Dengan
 * pemisahan ini, server key tidak pernah melewati lapisan aplikasi maupun
 * domain — dan palsuan untuk pengujian tidak membutuhkan kunci apa pun, sehingga
 * tidak ada nilai yang menyerupai kredensial di dalam berkas uji.
 *
 * Kuncinya juga tidak pernah dicatat: logger shared-kernel meredaksi field
 * bernama `serverKey`, tetapi yang paling aman adalah tidak pernah menaruhnya di
 * objek yang dicatat sama sekali.
 */
export function createSignatureVerifier(serverKey: string): SignatureVerifier {
  return {
    isValid(input: NotificationSignature): boolean {
      return isValidSignature(
        {
          orderId: input.orderId,
          statusCode: input.statusCode,
          grossAmount: input.grossAmount,
          serverKey,
        },
        input.signatureKey,
      )
    },
  }
}
