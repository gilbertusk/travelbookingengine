import { afterEach, describe, expect, test } from 'vitest'
import { loadSnap, openSnap, resetSnapLoader, returnParamOf } from './snap'

afterEach(() => {
  delete window.snap
  document.head.querySelectorAll('script').forEach((script) => {
    script.remove()
  })
  resetSnapLoader()
})

describe('memuat Snap', () => {
  test('tanpa client key: popup tidak dipakai, tanpa menyentuh jaringan', async () => {
    expect(await loadSnap({ scriptUrl: 'https://snap.example/snap.js' })).toBe(false)
    expect(document.head.querySelector('script')).toBeNull()
  })

  test('skrip dimuat dengan client key-nya, sekali saja', async () => {
    const first = loadSnap({
      clientKey: 'SB-Mid-client-x',
      scriptUrl: 'https://snap.example/snap.js',
    })
    const second = loadSnap({
      clientKey: 'SB-Mid-client-x',
      scriptUrl: 'https://snap.example/snap.js',
    })
    const scripts = document.head.querySelectorAll('script')
    expect(scripts).toHaveLength(1)
    expect(scripts[0]?.dataset.clientKey).toBe('SB-Mid-client-x')

    window.snap = { pay: () => undefined }
    scripts[0]?.dispatchEvent(new Event('load'))

    expect(await first).toBe(true)
    expect(await second).toBe(true)
  })

  test('skrip yang gagal dimuat jatuh ke halaman penuh, dan percobaan berikutnya memuat ulang', async () => {
    const attempt = loadSnap({ clientKey: 'k', scriptUrl: 'https://snap.example/snap.js' })
    document.head.querySelector('script')?.dispatchEvent(new Event('error'))

    expect(await attempt).toBe(false)
    expect(document.head.querySelector('script')).toBeNull()

    void loadSnap({ clientKey: 'k', scriptUrl: 'https://snap.example/snap.js' })
    expect(document.head.querySelectorAll('script')).toHaveLength(1)
  })
})

describe('popup', () => {
  test.each([
    ['onSuccess', 'success'],
    ['onPending', 'pending'],
    ['onError', 'error'],
    ['onClose', 'closed'],
  ] as const)('%s → %s', async (callback, outcome) => {
    const result = await openSnap('tok', {
      pay: (_token, callbacks) => {
        callbacks[callback]?.()
      },
    })

    expect(result).toBe(outcome)
  })
})

describe('kembali dari Snap penuh', () => {
  test.each([
    ['settlement', 'selesai'],
    ['capture', 'selesai'],
    ['pending', 'tertunda'],
    ['deny', 'gagal'],
    ['expire', 'gagal'],
    [null, 'ditutup'],
  ])('%s → %s', (status, param) => {
    expect(returnParamOf(status)).toBe(param)
  })
})
