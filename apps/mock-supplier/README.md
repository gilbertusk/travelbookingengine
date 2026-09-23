# mock-supplier

Lima supplier hotel tiruan dengan watak berbeda, ditambah panel kendali untuk menyuntikkan kegagalan sesuka hati.

Tanpa layanan ini, tidak satu pun klaim ketahanan di project ini dapat dibuktikan. Uji beban pada Step 15, uji konkurensi pada Step 22, dan uji chaos pada Step 28 semuanya bersandar pada kemampuan membuat supplier gagal pada waktu yang kita tentukan.

## Menjalankan

```bash
pnpm --filter @tbe/mock-supplier dev
```

Bawaan port 4000. Setel `MOCK_SUPPLIER_INSTANT=true` untuk melewati seluruh latensi tiruan — suntikan kegagalan tetap berlaku.

## Lima supplier

| Kode      | Protokol  | Mata uang | Latensi p50 | Watak                                              |
| --------- | --------- | --------- | ----------- | -------------------------------------------------- |
| **SKY**   | REST JSON | IDR       | ~180ms      | Cepat dan stabil, inventaris terlengkap (90%)      |
| **NOVA**  | REST JSON | USD       | ~600ms      | `snake_case`, tanggal ISO datetime, harga desimal  |
| **ORBIT** | SOAP XML  | IDR       | ~900ms      | `PascalCase`, tanggal `DD/MM/YYYY`                 |
| **LUNA**  | REST JSON | IDR       | ~2800ms     | Lambat, tanggal epoch detik, nama field terpangkas |
| **ZEPH**  | REST JSON | USD       | ~400ms      | Tidak stabil (~15% gagal), harga sebagai string    |

Perbedaan ini disengaja dan tidak boleh disederhanakan. Kalau kelimanya berbicara dengan cara yang sama, lapisan adapter pada Step 10 kehilangan alasan untuk ada.

**Jebakan yang ditanam sengaja:**

- ORBIT memakai `DD/MM/YYYY`. Parser yang mengasumsikan urutan Amerika akan salah tanggal, dan itu hanya terlihat pada tanggal di atas 12.
- NOVA mengirim tanggal menginap sebagai datetime UTC. Memotongnya begitu saja menggeser satu malam untuk properti di sebelah timur UTC.
- NOVA dan ZEPH menyebut harga dalam satuan utama berdesimal, bukan satuan terkecil.
- ZEPH mengirim harga dan sisa unit sebagai string.
- LUNA mengirim boolean sebagai `0`/`1`, dan tanggal sebagai epoch detik.
- Properti yang sama muncul di beberapa supplier dengan pengenal, nama, dan harga berbeda.

## Panel kendali kegagalan

```bash
# Matikan supplier sepenuhnya — koneksi diputus, bukan 503
curl -X POST localhost:4000/admin/luna/down

# Selalu gagal dengan mode tertentu
curl -X POST localhost:4000/admin/zeph/failure \
  -H 'content-type: application/json' \
  -d '{"rate": 1, "mode": "malformed"}'

# Lambatkan supplier ke 3 detik
curl -X POST localhost:4000/admin/sky/latency \
  -H 'content-type: application/json' \
  -d '{"min": 3000, "max": 3000}'

# Paksa harga selalu bergeser saat price check
curl -X POST localhost:4000/admin/sky/price-drift \
  -H 'content-type: application/json' \
  -d '{"rate": 1}'

# Pulihkan satu supplier, atau semuanya
curl -X POST localhost:4000/admin/sky/up
curl -X POST localhost:4000/admin/reset

# Kembalikan ketersediaan, hold, dan booking ke keadaan awal
curl -X POST localhost:4000/admin/inventory/reset

# Lihat keadaan seluruh supplier
curl localhost:4000/admin/state
```

### Mode kegagalan

| Mode               | Perilaku                              | Kenapa perlu diuji terpisah                 |
| ------------------ | ------------------------------------- | ------------------------------------------- |
| `server_error`     | 500                                   | Kegagalan yang jelas, layak dicoba ulang    |
| `unavailable`      | 503 dengan `Retry-After`              | Klien harus menghormati jeda yang diminta   |
| `timeout`          | Tidak membalas sampai klien menyerah  | Menguji batas waktu, bukan penanganan galat |
| `connection_reset` | Koneksi diputus tanpa respons         | Supplier mati tidak membalas apa pun        |
| `malformed`        | **200** dengan isi tidak dapat diurai | Paling berbahaya: status terlihat sehat     |
| `truncated`        | **200** dengan isi terpotong          | Sama, tetapi gagal di tengah pembacaan      |

Dua mode terakhir adalah alasan Step 10 mewajibkan validasi respons supplier. Kegagalan itu tidak terlihat sama sekali dari kode status.

## Contoh permintaan

```bash
# SKY — camelCase, IDR satuan terkecil
curl -X POST localhost:4000/sky/availability -H 'content-type: application/json' \
  -d '{"city":"Bali","checkIn":"2026-11-10","checkOut":"2026-11-12","guests":2}'

# NOVA — snake_case, USD desimal, tanggal ISO datetime
curl -X POST localhost:4000/nova/search -H 'content-type: application/json' \
  -d '{"destination":"Bali","arrival_date":"2026-11-10T00:00:00Z","departure_date":"2026-11-12T00:00:00Z","occupancy":{"adults":2}}'

# ORBIT — SOAP, DD/MM/YYYY
curl -X POST localhost:4000/orbit/soap -H 'content-type: text/xml' -H 'SOAPAction: Availability' \
  -d '<Envelope><Body><AvailabilityRequest><Location>Bali</Location><FromDate>10/11/2026</FromDate><ToDate>12/11/2026</ToDate><PaxCount>2</PaxCount></AvailabilityRequest></Body></Envelope>'

# LUNA — epoch detik, field terpangkas
curl -X POST localhost:4000/luna/availability -H 'content-type: application/json' \
  -d '{"q":{"loc":"Bali","in":1793318400,"out":1793491200,"pax":2}}'

# ZEPH — amplop status/payload, harga string
curl -X POST localhost:4000/zeph/availability -H 'content-type: application/json' \
  -d '{"location":"Bali","dates":{"from":"2026-11-10","to":"2026-11-12"},"pax":2}'
```

## Perilaku yang dijamin

Empat hal ini diuji dan menjadi landasan step-step berikutnya:

1. **Ketersediaan terbatas ditegakkan per malam.** Satu malam yang habis membuat seluruh rentang tidak dapat dipesan.
2. **Hold mengurangi ketersediaan sementara, dan dilepas otomatis saat kedaluwarsa.** Unit yang sudah menjadi booking tidak ikut dilepas.
3. **`book` idempoten terhadap idempotency key** — bahkan setelah hold-nya kedaluwarsa. Tanpa ini, percobaan ulang menghasilkan pemesanan ganda dan kerugian uang nyata.
4. **Status pemesanan dapat ditanyakan ulang lewat idempotency key.** Inilah jalan keluar dari ketidakpastian pada US-05: ketika `book` timeout, sistem tidak tahu apakah pemesanan terbentuk, dan bertanya dengan kuncinya adalah satu-satunya cara aman mencari tahu.

## Data

Deterministik sepenuhnya — tidak ada `Math.random` di jalur pembangkitan data. Katalog dan ketersediaan untuk tanggal tertentu selalu sama di setiap proses, sehingga hasil uji beban dapat dibandingkan antar-jalannya.

8 kota, 40 properti per kota, 2–4 jenis kamar, 2–3 rate plan per kamar. Ketersediaan per malam dihitung dari fungsi, bukan disimpan; yang tersimpan hanya unit yang sedang ditahan atau sudah terjual.

Keacakan sungguhan hanya dipakai untuk keputusan kegagalan dan pergeseran harga — kalau keduanya deterministik atas isi permintaan, percobaan ulang tidak akan pernah bisa berhasil dan kebijakan retry pada Step 11 tidak dapat diuji.
