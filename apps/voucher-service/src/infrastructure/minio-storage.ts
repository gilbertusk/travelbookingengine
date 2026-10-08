import { UpstreamError, type ManagedResource } from '@tbe/shared-kernel'
import { Client } from 'minio'
import type { VoucherStorage } from '../application/ports.js'

/**
 * Penyimpanan voucher di MinIO, bucket `vouchers`.
 *
 * Dua klien, dan pemisahannya bukan kebetulan:
 *
 * - `internal` menulis dan menghapus, lewat alamat yang dicapai service di
 *   jaringannya sendiri (mis. `minio:9000` di dalam Compose).
 * - `public` HANYA menandatangani URL. Tanda tangan S3 mencakup nama host, jadi
 *   URL harus ditandatangani untuk alamat yang akan dibuka PERAMBAN. URL yang
 *   ditandatangani untuk `minio:9000` tidak dapat dibuka dari luar, dan
 *   mengganti host-nya sesudah ditandatangani membatalkan tanda tangannya.
 *
 * Wilayah dinyatakan tetap pada kedua klien supaya penandatanganan tidak
 * memanggil `GetBucketLocation` — klien penandatangan tidak harus dapat
 * menjangkau alamat publiknya sendiri.
 */

export interface MinioOptions {
  readonly internalUrl: string
  readonly publicUrl: string
  readonly accessKey: string
  readonly secretKey: string
  readonly bucket: string
}

const REGION = 'us-east-1'
const CONTENT_TYPE = 'application/pdf'

function clientFor(url: string, options: MinioOptions): Client {
  const parsed = new URL(url)
  const isHttps = parsed.protocol === 'https:'

  return new Client({
    endPoint: parsed.hostname,
    port: parsed.port === '' ? (isHttps ? 443 : 80) : Number(parsed.port),
    useSSL: isHttps,
    accessKey: options.accessKey,
    secretKey: options.secretKey,
    region: REGION,
  })
}

export function createMinioStorage(options: MinioOptions): VoucherStorage & {
  readonly resource: ManagedResource
} {
  const internal = clientFor(options.internalUrl, options)
  const signer = clientFor(options.publicUrl, options)
  const { bucket } = options

  return {
    async put(objectKey, pdf) {
      await upstream('mengunggah voucher', async () => {
        await internal.putObject(bucket, objectKey, Buffer.from(pdf), pdf.byteLength, {
          'Content-Type': CONTENT_TYPE,
        })
      })
    },

    async remove(objectKey) {
      await upstream('menghapus voucher', async () => {
        await internal.removeObject(bucket, objectKey)
      })
    },

    async read(objectKey) {
      return await upstream('membaca voucher', async () => {
        const stream = await internal.getObject(bucket, objectKey)
        const chunks: Buffer[] = []
        for await (const chunk of stream) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
        }
        return new Uint8Array(Buffer.concat(chunks))
      })
    },

    async signedUrl(objectKey, ttlSeconds) {
      return await upstream('menandatangani URL voucher', async () => {
        // Nama berkas yang ramah untuk pengunduh; kunci objeknya sendiri acak.
        return await signer.presignedGetObject(bucket, objectKey, ttlSeconds, {
          'response-content-disposition': 'attachment; filename="e-voucher.pdf"',
          'response-content-type': CONTENT_TYPE,
        })
      })
    },

    resource: {
      name: 'minio',
      start: async () => {
        // Bucket dibuat infra (minio-init), bukan service ini: service yang
        // membuat bucket sendiri butuh hak lebih dari yang ia perlukan. Yang
        // diperiksa di sini hanya keberadaannya, supaya kesalahan konfigurasi
        // terlihat saat startup, bukan di voucher pertama.
        const exists = await internal.bucketExists(bucket)
        if (!exists) throw new Error(`bucket ${bucket} belum ada di MinIO`)
      },
      stop: async () => {
        await Promise.resolve()
      },
    },
  }
}

async function upstream<T>(action: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    throw new UpstreamError({ upstream: 'minio', message: `MinIO gagal ${action}`, cause: error })
  }
}
