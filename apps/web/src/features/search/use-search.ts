'use client'

import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { fetchProperty, fetchSearch, fetchSuggestions } from './api'
import { criteriaKey, type SearchCriteria } from './criteria'
import type { PropertyDetailResponse, SearchResponse, Suggestions } from './types'

/**
 * Pengambilan hasil pencarian.
 *
 * `placeholderData` menahan hasil LAMA selama yang baru diambil. Tanpa itu,
 * setiap perubahan penyaring mengosongkan layar menjadi skeleton — dan
 * mengosongkan layar untuk perubahan yang biasanya hanya membuang beberapa
 * kartu terasa jauh lebih lambat daripada yang sebenarnya.
 *
 * Yang ditukar: hasil yang terlihat sesaat bukan milik penyaring yang baru
 * dipilih. Itu sebabnya `isFetching` tetap diteruskan — antarmuka menandainya
 * sebagai sedang diperbarui, bukan berpura-pura sudah selesai.
 */
export function useSearch(criteria: SearchCriteria | undefined) {
  return useQuery<SearchResponse>({
    queryKey: ['search', criteria === undefined ? '' : criteriaKey(criteria)],
    queryFn: async ({ signal }) => {
      if (criteria === undefined) throw new Error('kriteria pencarian belum lengkap')

      return await fetchSearch(criteria, signal)
    },
    enabled: criteria !== undefined,
    placeholderData: (previous) => previous,
  })
}

export function useProperty(ref: string, criteria: SearchCriteria | undefined) {
  return useQuery<PropertyDetailResponse>({
    queryKey: ['property', ref, criteria === undefined ? '' : criteriaKey(criteria)],
    queryFn: async ({ signal }) => {
      if (criteria === undefined) throw new Error('kriteria pencarian belum lengkap')

      return await fetchProperty(ref, criteria, signal)
    },
    enabled: criteria !== undefined,
  })
}

/**
 * Jeda sebelum kueri saran dikirim.
 *
 * 250ms: cukup lama untuk melewati ketikan beruntun, cukup pendek untuk tidak
 * terasa seperti menunggu. Tanpa jeda, mengetik "yogyakarta" mengirim sepuluh
 * kueri dan sembilan di antaranya jawabannya dibuang sebelum sampai.
 */
const SUGGEST_DEBOUNCE_MS = 250

export function useSuggestions(query: string) {
  const debounced = useDebounced(query, SUGGEST_DEBOUNCE_MS)

  return useQuery<Suggestions>({
    queryKey: ['suggest', debounced],
    queryFn: async ({ signal }) => await fetchSuggestions(debounced, signal),
    // Saran adalah data statis yang hampir tidak pernah berubah dalam satu
    // sesi. Mengambilnya ulang hanya menambah beban tanpa informasi baru.
    staleTime: 5 * 60_000,
  })
}

export function useDebounced<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => {
      setSettled(value)
    }, delayMs)

    return () => {
      clearTimeout(timer)
    }
  }, [value, delayMs])

  return settled
}
