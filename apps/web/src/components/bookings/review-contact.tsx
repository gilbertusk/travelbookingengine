import { Mail } from 'lucide-react'
import { REVIEW_CONTACT_WITHIN } from '@/features/booking/timeline'
import { publicConfig } from '@/config'

/**
 * Cara menghubungi kami untuk pemesanan yang diperiksa manual (Step 26).
 *
 * Pengguna yang uangnya sedang ditahan tidak boleh hanya disuruh menunggu.
 * Ia diberi tahu kapan kami menghubunginya, dan ke mana ia dapat menulis lebih
 * dulu bila tidak mau menunggu.
 */
export function ReviewContact({ bookingId }: { readonly bookingId: string }) {
  const email = publicConfig.supportEmail
  const subject = encodeURIComponent(`Pemesanan ${bookingId}`)

  return (
    <section aria-labelledby="hubungi-kami" className="flex flex-col gap-2">
      <h2 id="hubungi-kami" className="text-h3 font-medium">
        Hubungi kami
      </h2>
      <p className="max-w-prose text-body text-muted-foreground">
        Kami menghubungimu lewat surel dalam {REVIEW_CONTACT_WITHIN}. Bila ingin menanyakannya lebih
        dulu, tulis ke kami dan sertakan nomor pemesanan ini.
      </p>
      <a
        href={`mailto:${email}?subject=${subject}`}
        className="inline-flex min-h-11 items-center gap-2 self-start text-body font-medium text-foreground underline underline-offset-4"
      >
        <Mail aria-hidden="true" className="size-4" />
        {email}
      </a>
    </section>
  )
}
