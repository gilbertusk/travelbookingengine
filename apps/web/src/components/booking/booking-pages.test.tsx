import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { FlowStep } from '@/features/booking/flow'
import type { BookingStatusState } from '@/features/booking/use-booking-status'
import type { BookingFlow } from '@/features/booking/use-booking-flow'
import type { PropertyDetailResponse } from '@/features/search/types'
import { sampleBooking, sampleStatus } from '@/testing/booking'
import { renderWithQuery } from '@/testing/render'
import { BookingFlowPage } from './booking-flow'
import { BookingStatusPage } from './booking-status-page'
import { PaymentReturn } from './payment-return'

/**
 * Halaman-halaman alur pemesanan, dengan kait datanya digantikan.
 *
 * Alurnya sendiri diuji di flow-controller.test.ts dan status-stream.test.ts.
 * Yang diuji di sini: setiap keadaan punya tampilan, dan tidak ada tampilan
 * tanpa jalan keluar.
 */

const navigation = vi.hoisted(() => ({
  params: new URLSearchParams(),
  push: vi.fn(),
  replace: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: navigation.push, replace: navigation.replace }),
  useSearchParams: () => navigation.params,
}))

const mocks = vi.hoisted((): { property: unknown; flow: unknown; status: unknown } => ({
  property: undefined,
  flow: undefined,
  status: undefined,
}))

vi.mock('@/features/search/use-search', () => ({
  useProperty: () => mocks.property,
}))
vi.mock('@/features/booking/use-booking-flow', () => ({
  useBookingFlow: () => mocks.flow,
  openPayment: vi.fn(),
}))
vi.mock('@/features/booking/use-booking-status', () => ({
  useBookingStatus: () => mocks.status,
}))
// Pratinjau pembatalan dan voucher diuji di components/bookings; di sini
// cukup jawaban yang tidak pernah tiba.
vi.mock('@/features/bookings/api', () => ({
  fetchCancellationPreview: () => new Promise(() => undefined),
  fetchVoucherLink: vi.fn(),
  cancelBooking: vi.fn(),
}))

const IDR = (amountMinor: number) => ({ amountMinor, currency: 'IDR' as const })

const PROPERTY: PropertyDetailResponse = {
  property: {
    ref: 'padma',
    mapped: true,
    slug: 'padma',
    name: 'Padma Legian',
    city: 'Bali',
    amenities: [],
    offers: [
      {
        supplier: 'SKY',
        supplierPropertyId: 'sky-1',
        supplierRatePlanId: 'SKY-RP-1',
        roomTypeName: 'Deluxe',
        ratePlanName: 'Termasuk sarapan',
        refundable: true,
        breakfastIncluded: true,
        unitsLeft: 4,
        total: IDR(2_442_000),
        base: IDR(2_000_000),
        markup: IDR(200_000),
        tax: IDR(242_000),
        taxName: 'PPN 11%',
      },
    ],
    suppliers: ['SKY'],
    lowestTotal: IDR(2_442_000),
  },
  meta: {
    source: 'live',
    suppliersResponded: ['SKY'],
    suppliersTimedOut: [],
    suppliersUnavailable: [],
    latencyMs: 100,
    partial: false,
  },
}

const SELECTION =
  'kota=Bali&mulai=2026-11-10&selesai=2026-11-12&properti=padma&penyedia=SKY&tarif=SKY-RP-1'

function flow(step: FlowStep, overrides: Partial<BookingFlow> = {}): BookingFlow {
  return {
    step,
    booking: undefined,
    offsetMs: 0,
    rateDialogOpen: false,
    accepting: false,
    paying: false,
    paymentClosed: false,
    getState: vi.fn(),
    subscribe: vi.fn(),
    resume: vi.fn(),
    submitGuest: vi.fn(),
    acceptNewPrice: vi.fn(),
    setRateDialogOpen: vi.fn(),
    pay: vi.fn(),
    retry: vi.fn(),
    expire: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  navigation.params = new URLSearchParams(SELECTION)
  navigation.push.mockReset()
  navigation.replace.mockReset()
  mocks.property = { data: PROPERTY, isLoading: false, error: null, refetch: vi.fn() }
  mocks.flow = flow({ step: 'details' })
})

describe('halaman pemesanan', () => {
  test('tanpa pilihan kamar: jalan ke pencarian', () => {
    navigation.params = new URLSearchParams()
    render(<BookingFlowPage />)

    expect(screen.getByText('Pilih kamar lebih dulu')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Cari penginapan' })).toHaveAttribute('href', '/cari')
  })

  test('memuat: skeleton, bukan spinner', () => {
    mocks.property = { data: undefined, isLoading: true, error: null, refetch: vi.fn() }
    render(<BookingFlowPage />)

    expect(screen.getByText('Memuat kamar pilihanmu')).toBeInTheDocument()
  })

  test('gagal memuat: dapat dicoba lagi', async () => {
    const refetch = vi.fn()
    mocks.property = { data: undefined, isLoading: false, error: new Error('x'), refetch }
    render(<BookingFlowPage />)

    await userEvent.setup().click(screen.getByRole('button', { name: 'Coba lagi' }))
    expect(refetch).toHaveBeenCalled()
  })

  test('tarif yang hilang dari pencarian: kembali ke kamar lain', () => {
    navigation.params = new URLSearchParams(SELECTION.replace('SKY-RP-1', 'HILANG'))
    render(<BookingFlowPage />)

    expect(screen.getByText('Tarif ini sudah tidak ditawarkan')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Lihat kamar lain' })).toHaveAttribute(
      'href',
      expect.stringContaining('/properti/padma?'),
    )
  })

  test('data tamu: ringkasan dengan pajak terlihat, aksi utama mengirim formulir', () => {
    render(<BookingFlowPage />)

    expect(screen.getByRole('heading', { name: 'Padma Legian' })).toBeInTheDocument()
    expect(screen.getByText('PPN 11%')).toBeInTheDocument()
    const submit = screen.getByRole('button', { name: 'Lanjutkan ke pembayaran' })
    expect(submit).toHaveAttribute('form', 'guest-form')
  })

  test('sedang bekerja: label langkahnya diumumkan, tombol tidak dapat diklik ulang', () => {
    mocks.flow = flow({ step: 'working', label: 'Menahan kamar untukmu…' })
    render(<BookingFlowPage />)

    expect(screen.getByRole('status')).toHaveTextContent('Menahan kamar untukmu…')
    expect(screen.getByRole('button', { name: 'Memproses…' })).toBeDisabled()
  })

  test('harga berubah: dialog, dan setelah ditutup tetap ada jalan membukanya lagi', async () => {
    const booking = sampleBooking()
    const setRateDialogOpen = vi.fn()
    mocks.flow = flow(
      {
        step: 'rate_changed',
        booking,
        previous: IDR(2_442_000),
        current: IDR(2_600_000),
        difference: IDR(158_000),
      },
      { rateDialogOpen: false, setRateDialogOpen, booking },
    )
    render(<BookingFlowPage />)

    await userEvent.setup().click(screen.getByRole('button', { name: 'Tinjau harga baru' }))
    expect(setRateDialogOpen).toHaveBeenCalledWith(true)
  })

  test('kamar tertahan: hitung mundur, dan tombol bayar menyebut totalnya', async () => {
    const booking = sampleBooking({ status: 'HELD', heldUntil: '2099-01-01T00:00:00.000Z' })
    const pay = vi.fn()
    mocks.flow = flow({ step: 'held', booking }, { booking, pay })
    render(<BookingFlowPage />)

    expect(screen.getByText(/Kamar ditahan untukmu/)).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: /^Bayar Rp/ }))
    expect(pay).toHaveBeenCalled()
  })

  test('popup ditutup: kamar masih ditahan, dapat dibuka lagi', () => {
    const booking = sampleBooking({ status: 'HELD', heldUntil: '2099-01-01T00:00:00.000Z' })
    mocks.flow = flow({ step: 'held', booking }, { booking, paymentClosed: true })
    render(<BookingFlowPage />)

    expect(screen.getByText(/Kamar masih ditahan/)).toBeInTheDocument()
  })

  test.each<[string, FlowStep, string]>([
    ['hold habis', { step: 'expired' }, 'Pilih kamar lagi'],
    ['kamar habis', { step: 'unavailable', reason: 'sold_out' }, 'Lihat kamar lain'],
    ['tarif hilang', { step: 'unavailable', reason: 'rate_gone' }, 'Lihat kamar lain'],
    [
      'gagal sementara',
      { step: 'failed', retry: 'hold', message: 'Belum ada yang ditagih.' },
      'Kembali ke properti',
    ],
  ])('%s: tidak ada layar buntu', (_name, step, action) => {
    mocks.flow = flow(step)
    render(<BookingFlowPage />)

    expect(screen.getByRole('link', { name: action })).toBeInTheDocument()
  })

  test('gagal membuka pembayaran: hitung mundur tetap terlihat', () => {
    const booking = sampleBooking({ status: 'HELD', heldUntil: '2099-01-01T00:00:00.000Z' })
    mocks.flow = flow({ step: 'failed', retry: 'pay', message: 'x' }, { booking })
    render(<BookingFlowPage />)

    expect(screen.getByText(/Kamar ditahan untukmu/)).toBeInTheDocument()
  })

  test('gagal sementara: Coba lagi menjalankan aksi yang sama', async () => {
    const retry = vi.fn()
    mocks.flow = flow({ step: 'failed', retry: 'check', message: 'x' }, { retry })
    render(<BookingFlowPage />)

    await userEvent.setup().click(screen.getByRole('button', { name: 'Coba lagi' }))
    expect(retry).toHaveBeenCalled()
  })
})

function statusState(overrides: Partial<BookingStatusState> = {}): BookingStatusState {
  return {
    booking: sampleBooking({ status: 'PAID' }),
    bookingError: null,
    isBookingLoading: false,
    refetchBooking: vi.fn(),
    status: sampleStatus(),
    mode: 'live',
    sessionExpired: false,
    ...overrides,
  }
}

describe('halaman status', () => {
  const ID = '018f0000-0000-7000-8000-000000000001'

  beforeEach(() => {
    navigation.params = new URLSearchParams()
    mocks.status = statusState()
  })

  test('menunggu supplier: tahapan berjalan, uang pengguna disebut aman', () => {
    render(<BookingStatusPage bookingId={ID} />)

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Pembayaran diterima')
    expect(screen.getByText(/Uangmu aman/)).toBeInTheDocument()
    expect(screen.getByText('Diperbarui otomatis')).toBeInTheDocument()
  })

  test('terkonfirmasi: kode pemesanan menonjol', () => {
    mocks.status = statusState({
      status: sampleStatus({ status: 'CONFIRMED', isFinal: true, supplierRef: 'SKY-BK-778812' }),
    })
    renderWithQuery(<BookingStatusPage bookingId={ID} />)

    expect(screen.getByRole('heading', { name: 'Kode pemesanan' })).toBeInTheDocument()
    expect(screen.getByText('SKY-BK-778812')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Unduh voucher/ })).toBeEnabled()
    expect(screen.getByRole('heading', { name: 'Kebijakan pembatalan' })).toBeInTheDocument()
  })

  test('gagal: menjelaskan pengembalian dana dengan bahasa manusia, tanpa kode internal', () => {
    mocks.status = statusState({
      status: sampleStatus({
        status: 'FAILED',
        refund: 'pending',
        failureReason: 'supplier menolak konfirmasi setelah tiga percobaan',
      }),
    })
    render(<BookingStatusPage bookingId={ID} />)

    expect(screen.getByText(/Pengembalian dana sedang diproses/)).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('tiga percobaan')
  })

  test('ditinjau: tampilan sendiri, tidak berpura-pura berhasil atau gagal', () => {
    mocks.status = statusState({
      status: sampleStatus({ status: 'NEEDS_REVIEW', isFinal: true, refund: 'review' }),
    })
    render(<BookingStatusPage bookingId={ID} />)

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('sedang kami periksa')
    expect(screen.getByText(/Pembayaranmu tercatat dan aman/)).toBeInTheDocument()
    // Cara menghubungi, bukan hanya "tunggu".
    expect(screen.getByRole('link', { name: /bantuan@/ })).toHaveAttribute(
      'href',
      expect.stringContaining('mailto:'),
    )
  })

  test('kembali dari popup yang ditutup: sapaan, dan pembayaran dapat dibuka lagi', () => {
    navigation.params = new URLSearchParams('bayar=ditutup')
    mocks.status = statusState({ status: sampleStatus({ status: 'HELD', saga: null }) })
    render(<BookingStatusPage bookingId={ID} />)

    expect(screen.getByText(/Jendela pembayaran ditutup sebelum selesai/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Buka pembayaran lagi' })).toBeInTheDocument()
  })

  test('sapaan popup tidak menimpa status yang sudah menjawab sendiri', () => {
    navigation.params = new URLSearchParams('bayar=ditutup')
    render(<BookingStatusPage bookingId={ID} />)

    expect(screen.queryByText(/Jendela pembayaran ditutup/)).toBeNull()
  })

  test('aliran beralih ke polling: tetap diberi tahu bahwa halaman diperbarui', () => {
    mocks.status = statusState({ mode: 'polling' })
    render(<BookingStatusPage bookingId={ID} />)

    expect(screen.getByText('Diperbarui setiap beberapa detik')).toBeInTheDocument()
  })

  test('memuat status: skeleton', () => {
    mocks.status = statusState({ status: undefined })
    render(<BookingStatusPage bookingId={ID} />)

    expect(screen.getByText('Memuat status pemesanan')).toBeInTheDocument()
  })

  test('sesi berakhir: masuk lagi lalu kembali ke pemesanan yang sama', () => {
    mocks.status = statusState({ sessionExpired: true })
    render(<BookingStatusPage bookingId={ID} />)

    expect(screen.getByRole('link', { name: 'Masuk' })).toHaveAttribute(
      'href',
      `/masuk?lanjut=${encodeURIComponent(`/bookings/${ID}`)}`,
    )
  })

  test('rincian gagal dimuat: status tetap tampil, rincian dapat dicoba lagi', async () => {
    const refetchBooking = vi.fn()
    mocks.status = statusState({ booking: undefined, bookingError: new Error('x'), refetchBooking })
    render(<BookingStatusPage bookingId={ID} />)

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Pembayaran diterima')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Coba lagi' }))
    expect(refetchBooking).toHaveBeenCalled()
  })
})

describe('kembali dari Snap halaman penuh', () => {
  test('meneruskan ke status pemesanan yang tadi dibayar', () => {
    window.sessionStorage.setItem('tbe:paying', 'b-7')
    navigation.params = new URLSearchParams('order_id=pay-1&transaction_status=settlement')
    render(<PaymentReturn />)

    expect(navigation.replace).toHaveBeenCalledWith('/bookings/b-7?bayar=selesai')
  })

  test('tanpa catatan pemesanan: daftar pemesanan, bukan jalan buntu', () => {
    navigation.params = new URLSearchParams('transaction_status=settlement')
    render(<PaymentReturn />)

    expect(screen.getByRole('link', { name: 'Lihat pemesananku' })).toHaveAttribute(
      'href',
      '/bookings',
    )
  })
})
