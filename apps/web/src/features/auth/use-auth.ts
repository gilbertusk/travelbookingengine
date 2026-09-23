'use client'

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { getAccessToken, setAccessToken } from '@/lib/access-token'
import { refreshAccessToken } from '@/lib/api-client'
import { fetchProfile, login, logout, register } from './api'
import type { LoginInput, RegisterInput, User } from './types'

/**
 * Hook fitur autentikasi.
 *
 * Kunci kueri disatukan di sini supaya pembatalan cache tidak bergantung pada
 * string yang diketik ulang di banyak tempat — satu salah ketik di sana
 * menghasilkan cache yang tidak pernah diperbarui, tanpa galat apa pun.
 */

export const authKeys = {
  profile: ['auth', 'profile'] as const,
}

/**
 * Sesi pengguna saat ini.
 *
 * Access token hanya ada di memori, jadi hilang setiap kali halaman dimuat
 * ulang. Kueri ini memulihkannya: refresh token di cookie httpOnly ditukar
 * sekali, lalu profil diambil. Inilah yang membuat penyimpanan token di
 * memori dapat dipakai tanpa memaksa pengguna masuk ulang setiap kali
 * menekan F5.
 */
export function useSession(): UseQueryResult<User | null> {
  return useQuery({
    queryKey: authKeys.profile,
    queryFn: async () => {
      if (getAccessToken() === undefined && !(await refreshAccessToken())) return null

      try {
        return await fetchProfile()
      } catch {
        // Tidak dilempar ulang: "tidak ada sesi" adalah jawaban yang sah,
        // bukan kegagalan. Melemparnya akan membuat setiap halaman publik
        // menampilkan keadaan galat kepada pengunjung yang belum masuk.
        setAccessToken(undefined)
        return null
      }
    },
    retry: false,
    staleTime: Infinity,
  })
}

export function useLogin() {
  const queryClient = useQueryClient()
  const router = useRouter()

  return useMutation({
    mutationFn: async (input: LoginInput) => await login(input),
    onSuccess: (session) => {
      queryClient.setQueryData(authKeys.profile, session.user)
      router.refresh()
    },
  })
}

export function useRegister() {
  const queryClient = useQueryClient()
  const router = useRouter()

  return useMutation({
    mutationFn: async (input: RegisterInput) => await register(input),
    onSuccess: (session) => {
      queryClient.setQueryData(authKeys.profile, session.user)
      router.refresh()
    },
  })
}

export function useLogout() {
  const queryClient = useQueryClient()
  const router = useRouter()

  return useMutation({
    mutationFn: logout,
    onSuccess: () => {
      // Seluruh cache dibuang, bukan hanya profil. Data pengguna sebelumnya
      // yang tertinggal di cache akan terlihat oleh siapa pun yang masuk
      // berikutnya di peramban yang sama.
      queryClient.clear()
      router.push('/')
      router.refresh()
    },
  })
}
