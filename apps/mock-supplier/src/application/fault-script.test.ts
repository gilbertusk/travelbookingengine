import { describe, expect, test } from 'vitest'
import { createFaultScript } from './fault-script.js'

describe('jadwal kegagalan per operasi', () => {
  test('kegagalan terjadwal hanya berlaku untuk operasi yang disebut', () => {
    const script = createFaultScript()
    script.add('SKY', { operation: 'book', mode: 'timeout', times: 1 })

    expect(script.take('SKY', 'lookup')).toBeUndefined()
    expect(script.take('SKY', 'book')).toBe('timeout')
  })

  test('kegagalan habis setelah dipakai sebanyak times', () => {
    const script = createFaultScript()
    script.add('SKY', { operation: 'book', mode: 'server_error', times: 2 })

    expect(script.take('SKY', 'book')).toBe('server_error')
    expect(script.pending('SKY')).toEqual([{ operation: 'book', mode: 'server_error', times: 1 }])
    expect(script.take('SKY', 'book')).toBe('server_error')
    expect(script.take('SKY', 'book')).toBeUndefined()
    expect(script.pending('SKY')).toEqual([])
  })

  test('kegagalan dipakai sesuai urutan pendaftaran', () => {
    const script = createFaultScript()
    script.add('SKY', { operation: 'book', mode: 'lose_response', times: 1 })
    script.add('SKY', { operation: 'book', mode: 'server_error', times: 1 })

    expect(script.take('SKY', 'book')).toBe('lose_response')
    expect(script.take('SKY', 'book')).toBe('server_error')
  })

  test('jadwal satu supplier tidak menyentuh supplier lain', () => {
    const script = createFaultScript()
    script.add('SKY', { operation: 'book', mode: 'timeout', times: 1 })

    expect(script.take('NOVA', 'book')).toBeUndefined()
    expect(script.pending('SKY')).toHaveLength(1)
  })

  test('clear mengosongkan seluruh jadwal', () => {
    const script = createFaultScript()
    script.add('SKY', { operation: 'book', mode: 'timeout', times: 3 })
    script.add('ZEPH', { operation: 'hold', mode: 'timeout', times: 1 })

    script.clear()

    expect(script.pending('SKY')).toEqual([])
    expect(script.pending('ZEPH')).toEqual([])
  })
})
