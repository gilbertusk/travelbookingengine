import { describe, expect, test } from 'vitest'
import { MIDTRANS_STATUS_MAP, mapMidtransStatus } from './provider-status.js'

/**
 * Seluruh nilai transaction_status yang didokumentasikan Midtrans.
 *
 * Daftar ini ditulis terpisah dari tabel pemetaannya dengan sengaja. Kalau
 * keduanya diturunkan dari sumber yang sama, uji kelengkapan di bawah hanya
 * akan membandingkan tabel dengan dirinya sendiri dan selalu lulus.
 */
const DOCUMENTED_STATUSES = [
  'capture',
  'settlement',
  'pending',
  'deny',
  'cancel',
  'expire',
  'failure',
  'authorize',
  'refund',
  'partial_refund',
] as const

describe('kelengkapan tabel', () => {
  test('setiap status yang didokumentasikan penyedia punya pemetaan', () => {
    for (const status of DOCUMENTED_STATUSES) {
      expect(MIDTRANS_STATUS_MAP[status], `status "${status}" belum dipetakan`).toBeDefined()
    }
  })

  test('tabel tidak memuat status yang tidak dikenal penyedia', () => {
    // Arah sebaliknya: baris yang tidak pernah dikirim penyedia adalah baris
    // yang tidak pernah diuji terhadap kenyataan.
    expect(Object.keys(MIDTRANS_STATUS_MAP).sort()).toEqual([...DOCUMENTED_STATUSES].sort())
  })
})

describe('pemetaan status', () => {
  test.each([
    ['capture', 'SUCCEEDED'],
    ['settlement', 'SUCCEEDED'],
    ['pending', 'PENDING'],
    ['authorize', 'PENDING'],
    ['deny', 'FAILED'],
    ['cancel', 'FAILED'],
    ['expire', 'FAILED'],
    ['failure', 'FAILED'],
  ])('%s dipetakan menjadi %s', (status, outcome) => {
    const mapping = mapMidtransStatus(status, undefined)

    expect(mapping.kind).toBe('outcome')
    if (mapping.kind !== 'outcome') return
    expect(mapping.outcome).toBe(outcome)
  })

  test.each(['refund', 'partial_refund'])('%s diabaikan, bukan diterapkan', (status) => {
    const mapping = mapMidtransStatus(status, undefined)

    // Keadaan refund dimiliki alur refund kita. Menerapkan notifikasi ini akan
    // membuat dua sumber kebenaran untuk satu fakta.
    expect(mapping.kind).toBe('ignored')
  })

  test('status yang tidak dikenal tidak dipetakan menjadi gagal', () => {
    const mapping = mapMidtransStatus('status_baru_yang_belum_ada', undefined)

    // Ini pokoknya: status tak dikenal yang jatuh ke `else` sebuah rangkaian if
    // akan menandai pembayaran GAGAL padahal uangnya mungkin sudah masuk.
    expect(mapping.kind).toBe('unsupported')
  })

  test('huruf besar tidak dinormalkan', () => {
    expect(mapMidtransStatus('SETTLEMENT', undefined).kind).toBe('unsupported')
  })

  test('status kosong tidak dipetakan', () => {
    expect(mapMidtransStatus('', undefined).kind).toBe('unsupported')
  })
})

describe('penimpaan hasil pemeriksaan penipuan', () => {
  test('capture dengan fraud_status accept tetap SUCCEEDED', () => {
    const mapping = mapMidtransStatus('capture', 'accept')

    expect(mapping).toEqual({ kind: 'outcome', outcome: 'SUCCEEDED' })
  })

  /**
   * Penyimpangan sengaja dari tabel yang diminta Step 18, dicatat sebagai
   * temuan pada step doc: `capture` + `challenge` berarti dana TERTAHAN dan
   * belum tentu masuk. Memperlakukannya sebagai sukses akan mengonfirmasi kamar
   * ke supplier atas pembayaran yang masih mungkin dibatalkan.
   */
  test('capture dengan fraud_status challenge ditahan sebagai PENDING', () => {
    const mapping = mapMidtransStatus('capture', 'challenge')

    expect(mapping).toEqual({ kind: 'outcome', outcome: 'PENDING' })
  })

  test('capture dengan fraud_status deny menjadi FAILED', () => {
    const mapping = mapMidtransStatus('capture', 'deny')

    expect(mapping).toEqual({ kind: 'outcome', outcome: 'FAILED' })
  })

  test('fraud_status yang tidak dikenal menahan pembayaran, bukan meloloskannya', () => {
    const mapping = mapMidtransStatus('settlement', 'nilai_baru_dari_penyedia')

    expect(mapping).toEqual({ kind: 'outcome', outcome: 'PENDING' })
  })

  test('fraud_status tidak mempengaruhi status yang bukan sukses', () => {
    // deny + challenge tetap gagal. Penipuan yang "hanya perlu ditinjau" tidak
    // membuat pembayaran yang sudah ditolak penerbit menjadi menunggu.
    expect(mapMidtransStatus('deny', 'challenge')).toEqual({
      kind: 'outcome',
      outcome: 'FAILED',
    })
  })

  test('fraud_status tidak mengubah status yang diabaikan', () => {
    expect(mapMidtransStatus('refund', 'challenge').kind).toBe('ignored')
  })
})
