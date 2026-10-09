'use client'

import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { ApiError } from '@/lib/api-error'
import { fetchBooking } from './api'
import { watchBookingStatus, type StreamMode } from './status-stream'
import type { Booking, BookingStatusView } from './types'

/**
 * Status pemesanan secara langsung (FR-26), ditambah rincian pemesanannya.
 *
 * Rincian — tanggal, harga — diambil sekali lewat TanStack Query; statusnya
 * dari aliran (status-stream.ts) yang mengurus sambung ulang dan polling.
 * Keduanya terpisah karena berubah dengan kecepatan yang sangat berbeda:
 * harga yang sudah dibayar tidak berubah, statusnya berubah dalam hitungan
 * detik.
 */
export interface BookingStatusState {
  readonly booking: Booking | undefined
  readonly bookingError: unknown
  readonly isBookingLoading: boolean
  readonly refetchBooking: () => void
  readonly status: BookingStatusView | undefined
  readonly mode: StreamMode
  readonly sessionExpired: boolean
}

export function useBookingStatus(bookingId: string): BookingStatusState {
  const details = useQuery({
    queryKey: ['booking', bookingId],
    queryFn: async ({ signal }) => await fetchBooking(bookingId, signal),
    // 404 tidak akan berubah dengan dicoba lagi.
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2,
  })
  const [status, setStatus] = useState<BookingStatusView>()
  const [mode, setMode] = useState<StreamMode>('connecting')
  const [sessionExpired, setSessionExpired] = useState(false)

  useEffect(() => {
    return watchBookingStatus({
      bookingId,
      onStatus: setStatus,
      onMode: setMode,
      onUnauthorized: () => {
        setSessionExpired(true)
      },
    })
  }, [bookingId])

  return {
    booking: details.data,
    bookingError: details.error,
    isBookingLoading: details.isLoading,
    refetchBooking: () => {
      void details.refetch()
    },
    status,
    mode,
    sessionExpired,
  }
}
