import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { BookingStatusTimeline } from './booking-status-timeline'
import { GuestForm } from './guest-form'
import { HoldCountdown } from './hold-countdown'
import { differenceLabel, formatMoney, RateChangeDialog } from './rate-change-dialog'
import { StaySummary } from './stay-summary'

const IDR = (amountMinor: number) => ({ amountMinor, currency: 'IDR' as const })

/** Teks uang seperti terbaca di DOM: spasi tak terputus Intl menjadi spasi biasa. */
const shown = (money: Parameters<typeof formatMoney>[0]) => formatMoney(money).replace(/\s/g, ' ')

describe('HoldCountdown', () => {
  const HELD_UNTIL = '2026-10-06T10:15:00.000Z'
  let clock = Date.parse('2026-10-06T10:00:00.000Z')
  const now = () => clock

  beforeEach(() => {
    vi.useFakeTimers()
    clock = Date.parse('2026-10-06T10:00:00.000Z')
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function advance(ms: number): void {
    act(() => {
      clock += ms
      vi.advanceTimersByTime(ms)
    })
  }

  test('memakai jam server: jam lokal yang terlambat tidak menambah waktu', () => {
    clock = Date.parse('2026-10-06T09:55:00.000Z')
    render(
      <HoldCountdown heldUntil={HELD_UNTIL} offsetMs={5 * 60_000} onExpire={vi.fn()} now={now} />,
    )

    expect(screen.getByText('15:00')).toBeInTheDocument()
  })

  test('netral di atas lima menit, peringatan di bawahnya — kalimatnya ikut berubah', () => {
    render(<HoldCountdown heldUntil={HELD_UNTIL} offsetMs={0} onExpire={vi.fn()} now={now} />)
    expect(screen.getByText(/Kamar ditahan untukmu/)).toBeInTheDocument()

    advance(10 * 60_000 + 1_000)

    expect(screen.getByText(/Segera selesaikan pembayaran/)).toBeInTheDocument()
  })

  test('pembaca layar diberi tahu di ambang, tidak setiap detik', () => {
    render(<HoldCountdown heldUntil={HELD_UNTIL} offsetMs={0} onExpire={vi.fn()} now={now} />)
    const live = screen.getByRole('status')
    expect(live).toHaveTextContent('')

    advance(4 * 60_000)
    expect(live).toHaveTextContent('')

    advance(60_000)
    expect(live).toHaveTextContent('Sisa waktu 10 menit.')

    advance(1_000)
    expect(live).toHaveTextContent('Sisa waktu 10 menit.')
  })

  test('habis: onExpire dipanggil SEKALI', () => {
    const onExpire = vi.fn()
    render(<HoldCountdown heldUntil={HELD_UNTIL} offsetMs={0} onExpire={onExpire} now={now} />)

    advance(15 * 60_000)
    advance(5_000)

    expect(onExpire).toHaveBeenCalledTimes(1)
    expect(screen.getByText('0:00')).toBeInTheDocument()
  })
})

describe('RateChangeDialog', () => {
  function renderDialog(overrides: Partial<Parameters<typeof RateChangeDialog>[0]> = {}) {
    const props = {
      open: true,
      previous: IDR(2_442_000),
      current: IDR(2_600_000),
      difference: IDR(158_000),
      accepting: false,
      onAccept: vi.fn(),
      onBack: vi.fn(),
      onOpenChange: vi.fn(),
      ...overrides,
    }
    render(<RateChangeDialog {...props} />)
    return props
  }

  test('harga lama, harga baru, dan selisihnya tertulis eksplisit', () => {
    renderDialog()

    expect(screen.getByText(shown(IDR(2_442_000)))).toBeInTheDocument()
    expect(screen.getByText(shown(IDR(2_600_000)))).toBeInTheDocument()
    expect(screen.getByText(`naik ${shown(IDR(158_000))}`)).toBeInTheDocument()
  })

  test('nadanya tenang: tidak ada peran alert dan tidak ada warna destruktif', () => {
    renderDialog()
    const dialog = screen.getByRole('dialog')

    expect(screen.queryByRole('alert')).toBeNull()
    expect(dialog.innerHTML).not.toMatch(/destructive/)
    expect(dialog).toHaveTextContent(/wajar/)
  })

  test('fokus terkunci di dalam dialog, dan Escape menutupnya', async () => {
    const user = userEvent.setup()
    const props = renderDialog()

    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement)
    await user.keyboard('{Escape}')

    expect(props.onOpenChange).toHaveBeenCalledWith(false)
  })

  test('aksi utama menerima, aksi sekunder kembali ke pencarian', async () => {
    const user = userEvent.setup()
    const props = renderDialog()

    await user.click(screen.getByRole('button', { name: 'Terima harga baru' }))
    await user.click(screen.getByRole('button', { name: 'Kembali ke hasil pencarian' }))

    expect(props.onAccept).toHaveBeenCalledTimes(1)
    expect(props.onBack).toHaveBeenCalledTimes(1)
  })

  test('selama memeriksa, tidak dapat diklik dua kali', () => {
    renderDialog({ accepting: true })

    expect(screen.getByRole('button', { name: 'Memeriksa harga…' })).toBeDisabled()
  })

  test('arah selisih ditulis dengan kata', () => {
    expect(differenceLabel(IDR(-40_000))).toBe(`turun ${formatMoney(IDR(40_000))}`)
    expect(differenceLabel(IDR(0))).toBe('tidak berubah')
    expect(formatMoney({ amountMinor: 12_345, currency: 'USD' })).toBe('$123.45')
  })
})

describe('GuestForm', () => {
  function renderForm(onSubmit = vi.fn()) {
    render(
      <>
        <GuestForm formId="f" onSubmit={onSubmit} />
        <button type="submit" form="f">
          Kirim
        </button>
      </>,
    )
    return onSubmit
  }

  test('setiap input punya label sungguhan', () => {
    renderForm()

    expect(screen.getByLabelText('Nama lengkap')).toBeInTheDocument()
    expect(screen.getByLabelText('Surel')).toBeInTheDocument()
  })

  test('divalidasi saat blur, bukan saat setiap ketukan', async () => {
    const user = userEvent.setup()
    renderForm()
    const email = screen.getByLabelText('Surel')

    await user.type(email, 'budi@')
    expect(screen.queryByText('Periksa lagi penulisan surelnya')).toBeNull()

    await user.tab()
    expect(await screen.findByText('Periksa lagi penulisan surelnya')).toBeInTheDocument()
    expect(email).toHaveAttribute('aria-invalid', 'true')
    // Galat di dekat inputnya, terhubung lewat aria-describedby.
    expect(email.getAttribute('aria-describedby')).toContain('guest-email-error')
  })

  test('nilai yang sah dikirim apa adanya, setelah dipangkas', async () => {
    const user = userEvent.setup()
    const onSubmit = renderForm()

    await user.type(screen.getByLabelText('Nama lengkap'), '  Budi Santoso ')
    await user.type(screen.getByLabelText('Surel'), 'budi@example.test')
    await user.click(screen.getByRole('button', { name: 'Kirim' }))

    await vi.waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1)
    })
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({
      fullName: 'Budi Santoso',
      email: 'budi@example.test',
    })
  })
})

describe('StaySummary', () => {
  test('rincian biaya termasuk pajak terlihat sejak awal', () => {
    render(
      <StaySummary
        propertyName="Padma Legian"
        roomName="Deluxe"
        city="Bali"
        checkIn="2026-11-10"
        checkOut="2026-11-12"
        guests={2}
        price={{
          lines: [
            { label: 'Harga kamar · 2 malam', amount: IDR(2_200_000) },
            { label: 'PPN 11%', amount: IDR(242_000) },
          ],
          total: IDR(2_442_000),
        }}
      />,
    )

    expect(screen.getByText('PPN 11%')).toBeInTheDocument()
    expect(screen.getByText(shown(IDR(2_442_000)))).toBeInTheDocument()
    expect(screen.getByText(/2 malam/, { selector: 'li' })).toBeInTheDocument()
  })

  test('harga yang belum diketahui tampil sebagai skeleton, bukan Rp 0', () => {
    render(
      <StaySummary
        propertyName="Padma"
        checkIn="2026-11-10"
        checkOut="2026-11-12"
        guests={2}
        price={undefined}
      />,
    )

    expect(screen.getByText('Memuat rincian harga')).toBeInTheDocument()
    expect(screen.queryByText(/Rp\s?0/)).toBeNull()
  })
})

describe('BookingStatusTimeline', () => {
  test('tahap sekarang ditandai aria-current, dan keadaannya tidak hanya lewat warna', () => {
    render(
      <BookingStatusTimeline
        stages={[
          { key: 'payment', label: 'Pembayaran diterima', state: 'done' },
          { key: 'confirming', label: 'Mengonfirmasi ke penyedia', state: 'current' },
          { key: 'confirmed', label: 'Pemesanan dikonfirmasi', state: 'pending' },
          { key: 'voucher', label: 'Voucher diterbitkan', state: 'pending' },
        ]}
      />,
    )

    const current = screen.getByText('Mengonfirmasi ke penyedia').closest('li')
    expect(current).toHaveAttribute('aria-current', 'step')
    expect(screen.getByText(/Pembayaran diterima/)).toHaveTextContent('selesai')
    expect(current).toHaveTextContent('sedang berjalan')
  })
})
