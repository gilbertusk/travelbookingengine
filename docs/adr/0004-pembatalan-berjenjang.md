# ADR-0004 — Pembatalan berjenjang dan saga pembatalan

**Status:** Diterima · **Tanggal:** 2026-10-09 · **Menjawab:** Step 25, keputusan Q3

## Konteks

FR-27 menuntut pengguna dapat membatalkan pemesanan dan menerima pengembalian dana sesuai kebijakan rate plan. G4 menuntut pembatalan itu "sesuai kebijakan yang berlaku". Q3 sudah dijawab di PRD: pengembalian **berjenjang** dengan nilai sebagian, yaitu 100% sampai 7 hari sebelum tanggal masuk, 50% sampai 24 jam, dan 0% setelahnya.

Empat hal belum diputuskan oleh Q3, dan masing-masing menentukan uang siapa yang hilang bila salah:

1. **Dari mana kebijakan yang mengikat diambil.** Sejak Step 23, kebijakan pembatalan masuk ke pemesanan dari hasil pencarian yang dikirim ulang peramban. Bentuknya diperiksa, isinya tidak. Untuk voucher itu utang yang dicatat. Untuk refund itu celah uang: pengguna dapat memesan rate non-refundable yang lebih murah, mengirim `refundable: true`, lalu membatalkannya dengan refund penuh.
2. **Bagaimana Q3 bergabung dengan tenggat supplier.** Satu supplier (SKY) menyebut "gratis sampai N hari sebelum check-in". Supplier lain hanya menyebut refundable atau tidak.
3. **Titik acuan tenggat.** "7 hari sebelum tanggal masuk", tetapi pukul berapa dan di zona mana. Data properti tidak punya jam check-in.
4. **Tempat pembatalan di mesin keadaan.** Step 16 menyatakan CONFIRMED final, tanpa transisi keluar, dan uji finalitas dua arah menegakkannya. Step 16 sendiri mencatat bahwa Step 25 akan menabrak ini.

## Keputusan

### 1. Kebijakan diverifikasi ke supplier saat price check

Price check kanonik (`priceCheckResultSchema`) kini **wajib** membawa `cancellationPolicy`. Kelima adapter membacanya dari jawaban supplier masing-masing (SKY `refundable` + `freeCancellationDays`, NOVA `is_refundable`, ORBIT `<Refundable>`, LUNA `ref`, ZEPH `cancellable`). Jawaban tanpa kebijakan ditolak sebagai `invalid_response`, bukan ditebak.

booking-service memakai kebijakan dari supplier untuk dua hal: menggantikan kebijakan di ketentuan tawaran (sehingga voucher mencetak versi yang sama), dan menurunkan jadwal pengembalian yang disimpan. Kebijakan yang dikirim peramban tidak pernah menentukan uang. Bila berbeda dari jawaban supplier, perbedaannya dicatat sebagai peringatan.

### 2. Jadwal sebagai daftar jenjang, disimpan saat memesan

```
RefundTier = { minHoursBefore: bilangan bulat ≥ 0, percent: bilangan bulat 0–100 }
```

Jenjang dibaca dari atas ke bawah. Yang pertama yang batas jamnya sudah terpenuhi adalah yang berlaku, dan batasnya inklusif. Jadwal yang kosong, tidak terurut, tumpang tindih, tidak menjangkau tanggal masuk, atau pengembaliannya membesar mendekati tanggal masuk **ditolak**, tidak diperbaiki diam-diam.

Penurunan dari kebijakan supplier:

| Kebijakan supplier                | Jadwal                                     |
| --------------------------------- | ------------------------------------------ |
| non-refundable                    | 0% kapan pun                               |
| refundable, tanpa tenggat         | Q3 apa adanya: 168 j → 100%, 24 j → 50%, 0 |
| refundable, gratis N hari (N > 1) | N×24 j → 100%, 24 j → 50%, 0               |
| refundable, gratis 1 hari         | 24 j → 100%, 0                             |
| refundable, gratis 0 hari         | 100% sampai tanggal masuk                  |

Jadwal disimpan di kolom `refund_schedule` setiap kali harga diverifikasi, dan dicatat di jejak audit (`PriceVerified`/`PriceChanged.refundTiers`). Pembatalan **tidak** menurunkannya ulang. Bila jenjang bawaan berubah bulan depan, pemesanan hari ini tetap memakai jadwal yang disepakati saat memesan.

Nilai dihitung dengan `allocate` dari `@tbe/money`. Sisa pembagian jatuh ke bagian yang dikembalikan, jadi tidak ada satuan terkecil yang hilang dan selisih pembulatan tidak pernah merugikan pengguna.

### 3. Acuan: pukul 00.00 tanggal masuk, di zona waktu properti

Zona waktu adalah fakta properti, dan katalog search-service adalah pemiliknya. booking-service menanyakannya saat pembatalan dihitung lewat `/internal/catalog/properties/by-supplier/...`. Zona itu tidak disalin saat memesan, karena ia bukan bagian kesepakatan.

Properti yang tidak dikenal katalog, atau zona yang tidak dikenal basis data IANA, membuat pembatalan **tidak dapat dihitung otomatis**. Sistem tidak menebak zona lain, karena selisih beberapa jam di sekitar tenggat berarti persentase yang lain.

Pukul 00.00 dipilih karena tidak bergantung pada data yang tidak dimiliki sistem, dan tenggatnya tidak pernah lebih longgar dari yang dijanjikan. Pada hari ketika tengah malam tidak terjadi (pergantian jam musim panas tepat pukul 00.00), acuannya detik pertama hari itu.

Pembatalan setelah acuan itu (menginap sudah dimulai di properti) ditolak dengan alasan `stay_started`.

### 4. CONFIRMED tetap final bagi sistem; pengguna dapat membukanya

Definisi keadaan final diubah dengan sengaja:

> Keadaan final adalah keadaan tanpa transisi keluar yang dijalankan **sistem** (saga, peristiwa, batas waktu, pemulihan).

CONFIRMED mendapat satu transisi keluar, `requestCancellation`, yang hanya dapat datang dari pemiliknya. Perintah semacam itu didaftar di `USER_INITIATED_COMMANDS`. Uji finalitas dua arah tetap berlaku, tetapi atas transisi sistem. Uji tambahan memastikan perintah pengguna tidak pernah dipasang pada keadaan yang digerakkan saga.

Dengan definisi ini, `isFinal(CONFIRMED)` tetap `true`. Layar status berhenti mendengarkan, saga Step 19 tetap menganggap CONFIRMED akhir yang sah, dan NFR-06 tidak berubah.

### Saga pembatalan

Pembatalan adalah saga kedua sistem ini, berjalan lewat keadaan tengah baru `CANCELLING`:

```
CONFIRMED ─requestCancellation→ CANCELLING(supplier) ─supplier.booking_cancelled→ CANCELLING(refund) ─payment.refunded→ CANCELLED
                                   │                        (nilai nol: langsung CANCELLED)        │
                                   ├─cancel_failed(refused)→ CONFIRMED                               ├─payment.refund_failed→ NEEDS_REVIEW
                                   ├─cancel_failed(uncertain)→ NEEDS_REVIEW                          └─batas waktu→ NEEDS_REVIEW
                                   └─batas waktu→ NEEDS_REVIEW
```

Urutannya: kamar dilepas dulu, uang kembali kemudian. Urutan inilah seluruh kompensasinya.

- **Supplier menolak membatalkan → tidak ada refund.** Kamar masih terpesan, dan mengembalikan uangnya berarti kerugian ganda. Pemesanan kembali CONFIRMED dengan booking reference yang sama, dan pengguna dapat mencoba lagi. "Menolak" berarti supplier sendiri yang menjawab tidak (galat 4xx setelah seluruh percobaan).
- **Pembatalan supplier tidak pasti → NEEDS_REVIEW, tanpa refund.** Batas waktu, galat 5xx, atau Kafka yang mati setelah pembatalan berhasil. Kamar mungkin sudah lepas, jadi pemesanan tidak dikembalikan ke CONFIRMED.
- **Refund gagal setelah supplier membatalkan → pembatalan supplier tidak dibalik.** Pemesanan ke NEEDS_REVIEW dengan galat tingkat error. Uang pengguna tertahan, dan itu urusan manusia.
- **Supplier tidak menjawab sebelum batas waktu → NEEDS_REVIEW.** Refund tidak dikirim, dan pemesanan tidak dikembalikan ke CONFIRMED. Status kamar yang tidak pasti adalah urusan manusia, seperti US-05.

Setiap peninjauan dari CANCELLING menulis booking reference dan nilai yang disetujui ke alasannya, karena NEEDS_REVIEW sendiri hanya membawa pembayaran.

Nilai yang dikembalikan adalah nilai **saat diminta**, bukan saat supplier menjawab. Pengguna tidak kehilangan jenjangnya karena supplier lambat.

Kedua jawaban yang sebelumnya tidak ada kini diterbitkan:

- `supplier.booking_cancelled` dan `supplier.booking_cancel_failed` (`outcome: refused | uncertain`) oleh supplier-service, termasuk dari dead letter;
- `payment.refund_failed` oleh payment-service, dari dead letter perintah `payment.refund`.

### Persetujuan dan idempotensi

`POST /bookings/:id/cancel` wajib membawa `expectedRefund`, yaitu nilai yang dilihat pengguna di `GET /bookings/:id/cancellation-preview`. Bila jenjangnya sudah berganti, jawabannya 409 dengan pratinjau yang baru, dan tidak ada yang dibatalkan.

Refund ganda dicegah di tiga lapis:

1. Kunci versi pemesanan: hanya satu permintaan yang memindahkan CONFIRMED ke CANCELLING. Permintaan lain dijawab `accepted` dengan keadaan yang menang.
2. Langkah di dalam CANCELLING: refund hanya dikirim dari langkah `supplier`, sekali.
3. Batasan UNIK `request_id` di payment-service. Pengenal refund pembatalan diturunkan deterministik dari pemesanan dan pembayarannya, dengan ruang nama sendiri. Setiap pengulangan membawa pengenal yang sama.

## Pilihan yang dipertimbangkan

**Mempercayai kebijakan dari peramban dan mencatatnya sebagai utang.** Ditolak oleh pengguna. Celahnya bukan soal tampilan; ia mengubah berapa uang yang keluar.

**Q3 untuk semua rate refundable, mengabaikan tenggat supplier.** Ditolak. Janji yang tampil di hasil pencarian ("gratis sampai 5 hari sebelumnya") akan berbeda dari yang dihitung saat pembatalan.

**Acuan pukul 14.00 (jam check-in umum).** Ditolak. Angkanya asumsi yang tidak ada di data properti.

**Pembatalan sebagai agregat terpisah** (CONFIRMED tetap tanpa jalan keluar, pembatalan hidup di tabelnya sendiri). Ditolak. Pemesanan yang sudah dibatalkan dan direfund akan tetap berstatus CONFIRMED, dan setiap pembaca (voucher, notifikasi, layar status, rekonsiliasi Step 28) harus tahu untuk memeriksa tabel kedua.

**Langsung CONFIRMED → CANCELLED dengan refund menyusul.** Ditolak. CANCELLED adalah keadaan final, dan pemesanan final dengan uang pengguna yang masih tertahan adalah alasan yang sama dengan larangan PAID → CANCELLED di Step 16.

## Konsekuensi

- Pemesanan sebelum Step 25 tidak punya jadwal (`refund_schedule = {"tiers": null}`). Pembatalannya dijawab `policy_unknown` dan diserahkan ke manusia.
- booking-service kini bergantung pada katalog search-service untuk menghitung pembatalan. Bila katalog tidak menjawab, pratinjau dan pembatalan dijawab 503, dan tidak ada yang berubah.
- `booking.failed` mendapat tahap `cancellation`. notification-service mengirim surel pemeriksaan yang tidak berkata "belum terkonfirmasi" dan tidak menjanjikan pengembalian penuh.
- Satu putaran penyapu saga kini juga menyapu pembatalan yang batas waktunya lewat, memakai batas waktu yang sama dengan saga pemesanan (`SAGA_CONFIRM_TIMEOUT_MS` untuk supplier, `SAGA_REFUND_TIMEOUT_MS` untuk refund).
