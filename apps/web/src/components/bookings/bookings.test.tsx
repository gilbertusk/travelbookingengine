import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type {
  BookingListItem,
  BookingListPage,
  CancellationPreview,
} from '@/features/bookings/types'
import { ApiError } from '@/lib/api-error'
import { renderWithQuery } from '@/testing/render'
import { BookingsList } from './bookings-list'
import { CancellationSection } from './cancellation-section'
import { VoucherDownload } from './voucher-download'

/**
 * Daftar pemesanan dan pembatalan (Step 26), dengan panggilan jaringannya
 * digantikan. Bentuk jawabannya diurai di features/bookings.
 */

const api = vi.hoisted(() => ({
  fetchBookingsPage: vi.fn(),
  fetchCancellationPreview: vi.fn(),
  cancelBooking: vi.fn(),
  fetchVoucherLink: vi.fn(),
}))

vi.mock('@/features/bookings/api', () => api)

const IDR = (amountMinor: number) => ({ amountMinor, currency: 'IDR' as const })
const ID = '018f0000-0000-7000-8000-000000000001'

function item(overrides: Partial<BookingListItem> = {}): BookingListItem {
  return {
    id: ID,
    status: 'CONFIRMED',
    isFinal: true,
    propertyName: 'Villa Sawah Ubud',
    city: 'Denpasar',
    roomTypeName: 'Deluxe King',
    checkIn: '2026-11-10',
    checkOut: '2026-11-12',
    guests: 2,
    supplierRef: 'SKY-BK-778812',
    total: IDR(2_442_000),
    refund: null,
    review: null,
    cancellation: null,
    ...overrides,
  }
}

function page(items: BookingListItem[], nextCursor: string | null = null): BookingListPage {
  return { items, nextCursor }
}

const QUOTE = {
  refund: IDR(1_221_000),
  percent: 50,
  until: '2026-11-08T16:00:00.000Z',
  next: { percent: 0 },
  nothingBack: null,
  tiers: [
    { percent: 100, until: '2026-11-06T16:00:00.000Z' },
    { percent: 50, until: '2026-11-08T16:00:00.000Z' },
    { percent: 0, until: '2026-11-09T16:00:00.000Z' },
  ],
  checkInStartsAt: '2026-11-09T16:00:00.000Z',
  timeZone: 'Asia/Makassar',
}

const CANCELLABLE: CancellationPreview = {
  bookingId: ID,
  cancellable: true,
  paid: IDR(2_442_000),
  quote: QUOTE,
  serverTime: '2026-11-07T03:00:00.000Z',
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe('daftar pemesanan', () => {
  test('setiap entri menyebut properti, tanggal, kode pemesanan, status dengan kata-kata, dan nilai', async () => {
    api.fetchBookingsPage.mockResolvedValue(page([item()]))

    renderWithQuery(<BookingsList />)

    const entry = await screen.findByRole('link', { name: /Villa Sawah Ubud/ })
    expect(entry).toHaveAttribute('href', `/bookings/${ID}`)
    expect(within(entry).getByText('Terkonfirmasi')).toBeInTheDocument()
    expect(within(entry).getByText('SKY-BK-778812')).toBeInTheDocument()
    expect(within(entry).getByText(/10 Nov 2026/)).toBeInTheDocument()
    expect(within(entry).getByText(/2\.442\.000/)).toBeInTheDocument()
  })

  test('dikelompokkan: akan datang, selesai, dibatalkan', async () => {
    api.fetchBookingsPage.mockResolvedValue(page([]))
    renderWithQuery(<BookingsList />)

    for (const name of ['Akan datang', 'Selesai', 'Dibatalkan']) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument()
    }

    await userEvent.click(screen.getByRole('tab', { name: 'Dibatalkan' }))

    await waitFor(() => {
      expect(api.fetchBookingsPage).toHaveBeenCalledWith('cancelled', undefined, expect.anything())
    })
  })

  test('kosong: penjelasan dan jalan ke pencarian', async () => {
    api.fetchBookingsPage.mockResolvedValue(page([]))

    renderWithQuery(<BookingsList />)

    expect(await screen.findByText('Belum ada perjalanan yang akan datang')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Cari penginapan' })).toHaveAttribute('href', '/cari')
  })

  test('memuat: skeleton yang diumumkan, bukan spinner', () => {
    api.fetchBookingsPage.mockReturnValue(new Promise(() => undefined))

    renderWithQuery(<BookingsList />)

    expect(screen.getByText('Memuat pemesanan')).toBeInTheDocument()
  })

  test('galat: bahasa manusia dan dapat dicoba lagi', async () => {
    api.fetchBookingsPage
      .mockRejectedValueOnce(
        new ApiError({ kind: 'network', status: 0, code: 'NETWORK_ERROR', message: 'x' }),
      )
      .mockResolvedValue(page([item()]))

    renderWithQuery(<BookingsList />)
    await userEvent.click(await screen.findByRole('button', { name: 'Coba lagi' }))

    expect(await screen.findByRole('link', { name: /Villa Sawah Ubud/ })).toBeInTheDocument()
  })

  test('berhalaman: muat lebih banyak sampai habis', async () => {
    api.fetchBookingsPage
      .mockResolvedValueOnce(page([item()], '10'))
      .mockResolvedValueOnce(page([item({ id: 'b-2', propertyName: 'Hotel Kedua' })]))

    renderWithQuery(<BookingsList />)
    await userEvent.click(await screen.findByRole('button', { name: 'Muat lebih banyak' }))

    expect(await screen.findByRole('link', { name: /Hotel Kedua/ })).toBeInTheDocument()
    expect(api.fetchBookingsPage).toHaveBeenLastCalledWith('upcoming', '10', expect.anything())
    expect(screen.queryByRole('button', { name: 'Muat lebih banyak' })).not.toBeInTheDocument()
  })

  test('pembatalan yang refundnya diperiksa tidak disembunyikan', async () => {
    api.fetchBookingsPage.mockResolvedValue(
      page([item({ status: 'NEEDS_REVIEW', review: 'cancellation', refund: 'review' })]),
    )

    renderWithQuery(<BookingsList />)

    expect(await screen.findByText('Pembatalan sedang diperiksa')).toBeInTheDocument()
  })

  test('properti yang tidak dikenal katalog tetap tampil dengan kotanya', async () => {
    api.fetchBookingsPage.mockResolvedValue(page([item({ propertyName: null })]))

    renderWithQuery(<BookingsList />)

    expect(await screen.findByText('Penginapan di Denpasar')).toBeInTheDocument()
  })
})

describe('kebijakan dan alur pembatalan', () => {
  test('tenggat ditampilkan sebagai tanggal dan jam konkret di zona properti', async () => {
    api.fetchCancellationPreview.mockResolvedValue(CANCELLABLE)

    renderWithQuery(<CancellationSection bookingId={ID} />)

    expect(
      await screen.findByText('Gratis dibatalkan sampai Jumat, 6 Nov 2026 pukul 23.59 WITA.'),
    ).toBeInTheDocument()
    expect(screen.getByText(/Bila dibatalkan sekarang/)).toHaveTextContent('1.221.000')
  })

  test('nilai yang kembali dan yang hangus terlihat sebelum tombol akhir', async () => {
    api.fetchCancellationPreview.mockResolvedValue(CANCELLABLE)
    renderWithQuery(<CancellationSection bookingId={ID} />)

    await userEvent.click(await screen.findByRole('button', { name: 'Batalkan pemesanan' }))

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Dana yang kembali').nextSibling).toHaveTextContent('1.221.000')
    expect(within(dialog).getByText('Dana yang hangus').nextSibling).toHaveTextContent('1.221.000')
    expect(within(dialog).getByText(/3–14 hari kerja/)).toBeInTheDocument()
    expect(api.cancelBooking).not.toHaveBeenCalled()
  })

  test('fokus awal pada "Jangan batalkan", dan Escape menutup tanpa membatalkan', async () => {
    api.fetchCancellationPreview.mockResolvedValue(CANCELLABLE)
    renderWithQuery(<CancellationSection bookingId={ID} />)

    await userEvent.click(await screen.findByRole('button', { name: 'Batalkan pemesanan' }))

    expect(screen.getByRole('button', { name: 'Jangan batalkan' })).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(api.cancelBooking).not.toHaveBeenCalled()
  })

  test('tombol akhir mengirim nilai yang ditampilkan', async () => {
    api.fetchCancellationPreview.mockResolvedValue(CANCELLABLE)
    api.cancelBooking.mockResolvedValue({})
    renderWithQuery(<CancellationSection bookingId={ID} />)

    await userEvent.click(await screen.findByRole('button', { name: 'Batalkan pemesanan' }))
    await userEvent.click(screen.getByRole('button', { name: 'Ya, batalkan pemesanan' }))

    expect(api.cancelBooking).toHaveBeenCalledWith(ID, IDR(1_221_000))
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
  })

  test('nilai yang berubah sejak pratinjau: tidak dibatalkan, nilai baru dimuat', async () => {
    api.fetchCancellationPreview
      .mockResolvedValueOnce(CANCELLABLE)
      .mockResolvedValue({ ...CANCELLABLE, quote: { ...QUOTE, refund: IDR(0), percent: 0 } })
    api.cancelBooking.mockRejectedValue(
      new ApiError({ kind: 'client', status: 409, code: 'REFUND_CHANGED', message: 'x' }),
    )
    renderWithQuery(<CancellationSection bookingId={ID} />)

    await userEvent.click(await screen.findByRole('button', { name: 'Batalkan pemesanan' }))
    await userEvent.click(screen.getByRole('button', { name: 'Ya, batalkan pemesanan' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/baru saja berubah/)
    await waitFor(() => {
      expect(
        within(screen.getByRole('dialog')).getByText('Dana yang kembali').nextSibling,
      ).toHaveTextContent('Rp')
    })
    expect(api.fetchCancellationPreview).toHaveBeenCalledTimes(2)
  })

  test('tanpa dana kembali: dikatakan terang-terangan, dengan tenggat yang terlewat', async () => {
    api.fetchCancellationPreview.mockResolvedValue({
      ...CANCELLABLE,
      quote: {
        ...QUOTE,
        refund: IDR(0),
        percent: 0,
        nothingBack: { kind: 'past_deadline', lastRefund: QUOTE.tiers[1] },
      },
    })
    renderWithQuery(<CancellationSection bookingId={ID} />)

    await userEvent.click(await screen.findByRole('button', { name: 'Batalkan pemesanan' }))

    expect(screen.getAllByText(/tidak ada dana yang kembali/i).length).toBeGreaterThan(0)
    expect(
      screen.getByText(/Tenggat pengembalian 50% berakhir Minggu, 8 Nov 2026/),
    ).toBeInTheDocument()
  })

  test('pemesanan yang tidak dapat dibatalkan: alasannya, tanpa tombol', async () => {
    api.fetchCancellationPreview.mockResolvedValue({
      bookingId: ID,
      cancellable: false,
      reason: 'stay_started',
      message: 'Tanggal masuk sudah tiba di properti. Pembatalan tidak lagi dapat dilakukan.',
      serverTime: '2026-11-10T03:00:00.000Z',
    })
    renderWithQuery(<CancellationSection bookingId={ID} />)

    expect(await screen.findByText(/Tanggal masuk sudah tiba/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Batalkan pemesanan' })).not.toBeInTheDocument()
  })

  test('pratinjau gagal dimuat: dapat dicoba lagi', async () => {
    api.fetchCancellationPreview
      .mockRejectedValueOnce(
        new ApiError({ kind: 'server', status: 503, code: 'CATALOG_UNAVAILABLE', message: 'x' }),
      )
      .mockResolvedValue(CANCELLABLE)
    renderWithQuery(<CancellationSection bookingId={ID} />)

    await userEvent.click(await screen.findByRole('button', { name: 'Coba lagi' }))

    expect(await screen.findByRole('button', { name: 'Batalkan pemesanan' })).toBeInTheDocument()
  })
})

describe('unduh voucher', () => {
  test('voucher yang belum siap dijelaskan, bukan galat mentah', async () => {
    api.fetchVoucherLink.mockRejectedValue(
      new ApiError({ kind: 'client', status: 409, code: 'NOT_READY', message: 'x' }),
    )
    renderWithQuery(<VoucherDownload bookingId={ID} />)

    await userEvent.click(screen.getByRole('button', { name: /Unduh voucher/ }))

    expect(await screen.findByRole('status')).toHaveTextContent(/sedang disiapkan/)
  })
})
