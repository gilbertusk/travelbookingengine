'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { Offer } from '@/features/search/types'
import { acceptPrice, fetchBooking, placeHold, priceCheck, startPayment } from './api'
import {
  createBookingFlow,
  type BookingFlowController,
  type FlowState,
  type PaymentOutcome,
} from './flow-controller'
import type { Selection } from './selection'
import { loadSnap, openSnap, PAYING_KEY } from './snap'
import { sessionStore } from './session-store'
import type { PaymentStart } from './types'

/** Keadaan alur beserta aksinya, seperti yang dipakai komponen. */
export type BookingFlow = FlowState & BookingFlowController

/**
 * Alur pemesanan untuk komponen: pengendali dari flow-controller.ts, dirangkai
 * dengan jaringan, router, Snap, dan sessionStorage yang sungguhan.
 *
 * Pengendalinya dibuat SEKALI per halaman. Pilihan kamar dan tawarannya tidak
 * berubah selama alur berjalan — perubahan URL dari pengendali sendiri
 * (`pesanan=`) tidak membuatnya ulang.
 */
export function useBookingFlow(selection: Selection, offer: Offer | undefined): BookingFlow {
  const router = useRouter()
  const [controller] = useState(() =>
    createBookingFlow(selection, offer, {
      api: { priceCheck, acceptPrice, placeHold, fetchBooking, startPayment },
      navigate: {
        replace: (href) => {
          router.replace(href, { scroll: false })
        },
        push: (href) => {
          router.push(href)
        },
      },
      openPayment,
      storage: sessionStore,
      now: () => Date.now(),
      newKey: () => `web-${crypto.randomUUID()}`,
      currentParams: () => new URLSearchParams(window.location.search),
    }),
  )
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)

  useEffect(() => {
    const abort = new AbortController()
    controller.resume(abort.signal)
    return () => {
      abort.abort()
    }
  }, [controller])

  return { ...controller, ...state }
}

/**
 * Popup Snap bila tersedia, halaman Snap penuh bila tidak. Pemesanan yang
 * sedang dibayar dicatat lebih dulu, supaya halaman kembalian Snap penuh tahu
 * ke status mana pengguna diarahkan.
 */
export async function openPayment(
  payment: PaymentStart,
  bookingId: string,
): Promise<PaymentOutcome> {
  sessionStore.set(PAYING_KEY, bookingId)

  if (await loadSnap()) {
    const snap = window.snap
    if (snap !== undefined) return await openSnap(payment.snapToken, snap)
  }

  window.location.assign(payment.redirectUrl)
  return 'redirected'
}
