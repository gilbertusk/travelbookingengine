import { useRef } from 'react'
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { useScrollAnchor } from './use-scroll-anchor'

/**
 * Penahan posisi baca.
 *
 * jsdom tidak melakukan tata letak, jadi posisi setiap kartu ditentukan
 * pengujian lewat tabel `tops` yang dibaca saat `getBoundingClientRect`
 * dipanggil — bukan saat elemennya dibuat. Pembacaan yang malas itu penting:
 * yang diuji adalah perbandingan posisi SEBELUM dan SESUDAH daftar berubah,
 * dan keduanya harus dapat berbeda untuk elemen yang sama.
 *
 * Yang diuji bukan perhitungan tata letak peramban — melainkan keputusan di
 * sekitarnya: elemen mana yang dijadikan jangkar, kapan koreksi dilakukan,
 * dan kapan justru tidak boleh dilakukan.
 */

let scrollBy: ReturnType<typeof vi.fn>
let tops: Record<string, number>
let originalRect: () => DOMRect

beforeEach(() => {
  scrollBy = vi.fn()
  tops = {}
  vi.stubGlobal('scrollBy', scrollBy)

  // eslint-disable-next-line @typescript-eslint/unbound-method -- disimpan untuk dipulihkan apa adanya
  originalRect = Element.prototype.getBoundingClientRect
  Element.prototype.getBoundingClientRect = function rect(this: Element): DOMRect {
    const key = (this as HTMLElement).dataset.anchorKey

    return { top: key === undefined ? 0 : (tops[key] ?? 0) } as DOMRect
  }
})

afterEach(() => {
  Element.prototype.getBoundingClientRect = originalRect
  vi.unstubAllGlobals()
})

function List({
  items,
  token,
  enabled = true,
}: {
  readonly items: readonly string[]
  readonly token: string
  readonly enabled?: boolean
}) {
  const container = useRef<HTMLDivElement>(null)
  useScrollAnchor(container, { token, enabled })

  return (
    <div ref={container}>
      {items.map((item) => (
        <article key={item} data-anchor-key={item}>
          {item}
        </article>
      ))}
    </div>
  )
}

describe('hasil baru menyisip di atas posisi baca', () => {
  test('halaman digulir balik sebanyak pergeserannya', () => {
    // Pengguna sedang membaca kartu `b`, 100px dari puncak viewport.
    tops = { a: -200, b: 100, c: 400 }
    const view = render(<List items={['a', 'b', 'c']} token="1" />)
    scrollBy.mockClear()

    // Satu hotel yang lebih murah menyisip di atas, mendorong `b` ke 400px.
    tops = { a: -200, baru: 100, b: 400, c: 700 }
    view.rerender(<List items={['a', 'baru', 'b', 'c']} token="2" />)

    expect(scrollBy).toHaveBeenCalledWith(0, 300)
  })

  test('jangkarnya kartu pertama yang TERLIHAT, bukan kartu pertama daftar', () => {
    // Setelah pengguna menggulir, kartu pertama ada jauh di atas layar.
    // Menjangkarkan padanya menghasilkan koreksi yang keliru jauh.
    tops = { a: -900, b: 50, c: 300 }
    const view = render(<List items={['a', 'b', 'c']} token="1" />)
    scrollBy.mockClear()

    // `a` bergeser 1000px, `b` hanya 120px. Yang dikoreksi harus 120.
    tops = { a: -1_900, b: 170, c: 420 }
    view.rerender(<List items={['a', 'b', 'c']} token="2" />)

    expect(scrollBy).toHaveBeenCalledWith(0, 120)
  })

  test('hasil yang menyisip di BAWAH posisi baca tidak menggeser apa pun', () => {
    tops = { a: 100, b: 300 }
    const view = render(<List items={['a', 'b']} token="1" />)
    scrollBy.mockClear()

    tops = { a: 100, b: 300, c: 500 }
    view.rerender(<List items={['a', 'b', 'c']} token="2" />)

    expect(scrollBy).not.toHaveBeenCalled()
  })

  test('pergeseran di bawah satu piksel diabaikan', () => {
    // Pembulatan sub-piksel tidak layak memicu gulir.
    tops = { a: 100 }
    const view = render(<List items={['a']} token="1" />)
    scrollBy.mockClear()

    tops = { a: 100.4 }
    view.rerender(<List items={['a']} token="2" />)

    expect(scrollBy).not.toHaveBeenCalled()
  })

  test('pergeseran ke atas juga dikoreksi', () => {
    // Penyaring yang membuang satu hotel di atas posisi baca menarik sisanya
    // ke atas. Sama mengganggunya, arah sebaliknya.
    tops = { a: -100, b: 200, c: 400 }
    const view = render(<List items={['a', 'b', 'c']} token="1" />)
    scrollBy.mockClear()

    tops = { b: 50, c: 250 }
    view.rerender(<List items={['b', 'c']} token="2" />)

    expect(scrollBy).toHaveBeenCalledWith(0, -150)
  })
})

describe('kapan koreksi TIDAK dilakukan', () => {
  test('saat dimatikan — belum ada yang dibaca pengguna', () => {
    tops = { a: 100 }
    const view = render(<List items={['a']} token="1" enabled={false} />)
    scrollBy.mockClear()

    tops = { baru: 100, a: 400 }
    view.rerender(<List items={['baru', 'a']} token="2" enabled={false} />)

    expect(scrollBy).not.toHaveBeenCalled()
  })

  test('saat kartu jangkarnya hilang dari daftar', () => {
    // Penyaring yang membuang hotel yang sedang dibaca. Tidak ada titik acuan
    // yang masuk akal, jadi lebih baik tidak menggeser apa pun daripada
    // menggeser menurut tebakan.
    tops = { a: 100, b: 300 }
    const view = render(<List items={['a', 'b']} token="1" />)
    scrollBy.mockClear()

    tops = { b: 100 }
    view.rerender(<List items={['b']} token="2" />)

    expect(scrollBy).not.toHaveBeenCalled()
  })

  test('pada render pertama — belum ada apa pun untuk dibandingkan', () => {
    tops = { a: 100, b: 300 }
    render(<List items={['a', 'b']} token="1" />)

    expect(scrollBy).not.toHaveBeenCalled()
  })

  test('ketika seluruh kartu berada di atas layar', () => {
    // Tidak ada kartu yang terlihat berarti tidak ada posisi baca yang perlu
    // dipertahankan.
    tops = { a: -500, b: -200 }
    const view = render(<List items={['a', 'b']} token="1" />)
    scrollBy.mockClear()

    tops = { a: -900, b: -600 }
    view.rerender(<List items={['a', 'b']} token="2" />)

    expect(scrollBy).not.toHaveBeenCalled()
  })

  test('daftar kosong tidak menggagalkan apa pun', () => {
    const view = render(<List items={[]} token="1" />)

    expect(() => {
      view.rerender(<List items={[]} token="2" />)
    }).not.toThrow()
    expect(scrollBy).not.toHaveBeenCalled()
  })
})
