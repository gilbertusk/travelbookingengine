# apps/ops — panel operator

Panel operator (Step 27, keputusan Q6): aplikasi Next.js TERPISAH dari apps/web, berbagi token dan primitif lewat `@tbe/ui`. Port 3001. Tidak untuk diakses publik.

```bash
API_URL=http://localhost:4001 pnpm --filter @tbe/ops dev
DATABASE_URL=<auth db> pnpm --filter @tbe/auth-service operator:grant sari@example.com
```

## Halaman

| Path        | Isi                                                                                       | FR    |
| ----------- | ----------------------------------------------------------------------------------------- | ----- |
| `/`         | Kesehatan supplier: pemutus per operasi, galat dan p50/p95 lima belas menit, tiap 3 s     | FR-31 |
| `/supplier` | Aktif/nonaktif dan ambang pemutus                                                         | FR-29 |
| `/markup`   | Aturan markup, dengan pratinjau dampak sebelum disimpan                                   | FR-30 |
| `/tinjauan` | Antrean NEEDS_REVIEW: jejak booking_events, saga, pembayaran, catatan permintaan supplier | —     |
| `/kendali`  | Panel kendali mock supplier: matikan, kegagalan, latensi, pulihkan                        | FR-32 |
| `/analitik` | Corong, performa supplier, kota dan rentang terpopuler, sebab kegagalan                   | FR-31 |

## Keamanan

**Pemisahan aplikasi adalah batasnya.** Kode operator tidak pernah ikut dalam bundel apps/web karena dibangun dari aplikasi lain. Peran tetap diperiksa tiga kali: di halaman masuk (kenyamanan), di gateway (403 untuk token tanpa `role: operator`), dan di setiap service (`requireOperator`).

**Peramban tidak memegang token dan tidak tahu alamat gateway.** Halaman memanggil `/api/ops/<sisa>` di aplikasi ini; rute server meneruskannya ke `<gateway>/ops/<sisa>` dengan access token dari cookie httpOnly ([`src/lib/ops-proxy.ts`](src/lib/ops-proxy.ts)):

- Jalur dibatasi KE `/ops/` — segmen `..`, `.`, atau berkarakter aneh dijawab 400. Tanpa batas ini rute ini menjadi proksi terbuka yang menempelkan token operator ke jalur gateway mana pun.
- 401 → refresh token dipakai SEKALI, lalu permintaan diulang. Refresh gagal → cookie dihapus. 403 tidak memicu refresh: token baru membawa peran yang sama.
- Penulisan (`POST`, `PATCH`, `DELETE`) hanya dari asal yang sama (header `Origin`), di atas cookie `SameSite=Strict`.
- Kedua cookie httpOnly; nama berbeda dari apps/web supaya sesi kedua aplikasi tidak saling menimpa di domain yang sama.

**Akun pelanggan ditolak saat masuk dan sesinya dicabut** di auth-service, supaya tidak ada refresh token pelanggan tanpa pemilik.

Header: `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`.

## Keputusan tampilan

Fungsional, tidak dipoles (Step 27). Token dan primitif sama dengan apps/web; tabel padat dipakai di sini. Data selalu dianggap basi (`staleTime: 0`) dan diambil ulang saat tab kembali difokuskan — operator yang kembali setelah lima menit harus melihat keadaan pemutus SEKARANG. Polling, bukan SSE: satu-dua operator, dan tiga detik lebih cepat dari jendela pemutus mana pun.

Jawaban service divalidasi dengan Zod di peramban: bidang yang diam-diam berganti nama tidak boleh tampil sebagai "kosong" yang tampak sah.

## Pengujian

```bash
pnpm --filter @tbe/ops test   # cakupan ≥ 80% baris, ≥ 75% cabang — sama dengan apps/web
```

Diuji: pembatasan jalur, refresh sekali, atribut cookie, penolakan lintas asal, login yang menolak pelanggan dan mencabut sesinya, validasi jawaban, dan permintaan yang dikirim tiap halaman (fetch palsuan). Berkas rute `app/**` hanya merangkai dan tidak masuk cakupan.

Dijalankan ujung ke ujung secara manual (lihat Bukti Step 27) terhadap auth-service, api-gateway, analytics-service, dan mock supplier sungguhan. **Belum** dijalankan ujung ke ujung: halaman kesehatan, konfigurasi, markup, dan tinjauan terhadap supplier-, pricing-, booking-, dan payment-service yang hidup; belum ada uji Playwright; tampilan belum diperiksa di peramban (hanya HTML dan status HTTP).
