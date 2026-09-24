# search-service

Jantung produk: orkestrator pencarian teragregasi, katalog properti, dan pemetaan supplier.

Memenuhi FR-01 sampai FR-05, FR-08, FR-10, NFR-01, dan NFR-03. Konsekuensi langsung [ADR-0001](../../docs/adr/0001-identitas-properti-lintas-supplier.md).

## Anggaran waktu, dan apa yang terjadi setelahnya

**Masalah nomor 1 di PRD: latensi supplier tidak seragam.** LUNA menjawab sekitar tiga detik. Menunggunya berarti seluruh pencarian menunggu tiga detik, dan pengguna sudah pergi jauh sebelum itu.

Fan-out berjalan dengan anggaran waktu — 1200ms sebagai titik awal. Setelah anggaran habis, hasil dari supplier yang sudah menjawab dikembalikan apa adanya.

**Supplier yang melewati anggaran TIDAK dibatalkan.**

```
t=0     ┌── SKY   ──► 200ms  ✓ masuk hasil
        ├── NOVA  ──► 600ms  ✓ masuk hasil
        └── LUNA  ──────────────────────► 3000ms
t=1200  hasil dikembalikan (SKY, NOVA)          │
                                                ▼
                                    disimpan ke cache lapis 2
                                    pencarian berikutnya dapat LUNA
                                    tanpa menunggu sedetik pun
```

Inilah butir terakhir US-01, dan detail yang membedakan implementasi serius dari yang asal jalan. Tanpa ini LUNA tidak pernah berkontribusi sama sekali: ia selalu terlambat, jadi inventarisnya hilang **selamanya** dari hasil pencarian — bukan karena tidak ada, melainkan karena tidak pernah sempat.

Dibuktikan tanpa satu milidetik pun benar-benar berlalu. Anggaran diwakili port `Deadline` yang dihabiskan tangan oleh pengujian, dan supplier yang menggantung dilepas ketika pengujian memutuskannya. Uji yang benar-benar menunggu 1200ms akan lambat; uji yang menunggu 50ms akan lulus di mesin cepat dan gagal di CI yang sibuk. Keduanya menguji penjadwal sistem operasi, bukan kode ini.

## Cache berlapis

|         | Isinya                       | Kunci                          | TTL    |
| ------- | ---------------------------- | ------------------------------ | ------ |
| Lapis 1 | hasil gabungan berharga jual | seluruh kriteria + penyaring   | 5 mnt  |
| Lapis 2 | jawaban mentah satu supplier | supplier + kota, tanggal, tamu | 10 mnt |

Pembagiannya bukan optimasi bertingkat. Lapis kedua punya satu tugas yang tidak dapat dilakukan lapis pertama: **memanen jawaban yang datang setelah anggaran habis.** Ia juga alasan pemulihan satu supplier tidak membatalkan seluruh cache — yang kedaluwarsa hanya entri supplier itu.

Kunci lapis kedua sengaja **tidak memuat penyaring maupun urutan**: keduanya diterapkan pada hasil, bukan pada permintaan ke supplier. Menyertakannya akan memecah entri cache per kombinasi penyaring sementara jawaban supplier-nya sama persis.

### Normalisasi menentukan apakah cache bekerja

Huruf besar-kecil kota, spasi berlebih, dan urutan daftar fasilitas semuanya adalah pencarian yang sama bagi pengguna. Kalau kuncinya berbeda, setiap variasi memicu fan-out sendiri dan tingkat kena cache runtuh **tanpa satu pun galat yang terlihat**.

Sebaliknya, kriteria yang benar-benar berbeda tidak boleh bertabrakan: hasil untuk dua tamu yang disajikan kepada pemesan empat tamu adalah kesalahan yang baru ketahuan saat pemesanannya ditolak. Kedua sifat itu diuji terpisah — menguji hanya yang pertama akan lulus dengan kunci konstan.

### Cache stampede

Seratus permintaan serentak untuk kunci yang sama hanya memicu **satu** fan-out:

```ts
const responses = await Promise.all(Array.from({ length: 100 }, () => run(world)))

expect(world.suppliers.searched.get('SKY')).toBe(1)
expect(world.pricing.calls.count).toBe(1)
expect(responses.every((item) => item.properties.length === 1)).toBe(true)
```

Baris terakhir penting: menghitung panggilan saja dapat lulus dengan kode yang mengembalikan hasil kosong untuk sembilan puluh sembilan di antaranya.

Penguncian dua lapis — dalam proses, lalu di Redis. Yang kalah mengambil kunci **menjalankan pekerjaannya sendiri**, bukan menunggu pemegang kunci: menunggu mengubah kegagalan satu pemegang kunci menjadi kegagalan seratus permintaan sekaligus.

## Hasil parsial

Setiap respons membawa metadata yang menyebut siapa menjawab, siapa kehabisan waktu, dan siapa sedang tidak tersedia. Komponen `PartialResultNotice` di DESIGN-SYSTEM.md memakainya.

Respons dari cache **menandai dirinya beserta umurnya**. Klien yang tidak tahu datanya berumur empat menit tidak dapat memutuskan apa pun tentangnya.

Supplier dengan pemutus sirkuit terbuka **dilewati tanpa dipanggil** — bukan dipanggil lalu ditolak cepat. Keadaan pemutusnya dibaca dari daftar supplier yang diterbitkan supplier-service; itulah sebabnya Step 13 menambahkan bidang `circuit.state` di sana.

## Penetapan harga

Seluruh tawaran dilewatkan ke pricing-service dalam **satu panggilan**, bukan satu per rate plan. Bentuk port-nya yang menjaganya: tidak ada metode yang menerima satu tawaran, jadi tidak ada cara memanggilnya per rate plan bahkan kalau seseorang ingin.

Harga yang dikembalikan ke klien **selalu harga jual**. `supplierTotal` tidak ada di bentuk yang dikirim keluar — bidang yang tidak ada tidak dapat bocor tanpa sengaja. Tawaran yang gagal dihitung harganya **dibuang**, bukan dikembalikan dengan harga supplier: menampilkan harga supplier berarti menjual tanpa markup.

Penyaring harga karena itu berjalan **setelah** penetapan harga — ia bekerja pada harga jual. Menyaring pada harga supplier akan membuang tawaran yang sebenarnya masuk anggaran pengguna, dan menyisakan yang setelah markup justru melewatinya.

## Katalog properti dan pemetaan supplier

Bagian di bawah ini dibangun pada Step 12b.

### Batas yang tidak boleh dilanggar

**Katalog menyimpan data statis saja. Harga dan ketersediaan tidak pernah disimpan.**

Melanggarnya tidak menggagalkan apa pun hari itu juga, dan justru itulah bahayanya. Satu kolom `lowestPrice` terasa praktis saat ditambahkan — ia menghemat satu panggilan, halamannya terasa lebih cepat, dan tidak ada satu pun uji yang gagal. Yang terjadi kemudian: angka itu basi dalam hitungan menit, pengguna melihat harga yang tidak ada lagi, lalu pemesanannya ditolak saat pembayaran. Itu kegagalan produk yang paling merusak kepercayaan.

Komentar di `schema.prisma` tidak menghentikan siapa pun. Skrip ini bisa:

```bash
pnpm verify:catalog
```

Ia memeriksa ketiga model katalog untuk kolom bernama harga atau ketersediaan, dan menolak berjalan kalau modelnya sudah berganti nama — skrip yang memeriksa model yang tidak ada lagi akan lulus karena buta, bukan karena bersih.

### Deduplikasi adalah pencarian di tabel

Satu hotel fisik dijual beberapa supplier dengan pengenal, ejaan nama, dan harga berbeda:

| Supplier | Pengenal         | Nama                              |
| -------- | ---------------- | --------------------------------- |
| SKY      | `sky-120804930`  | `Padma Bali Boutique Hotel`       |
| NOVA     | `nova-345515035` | `PADMA BALI BOUTIQUE HOTEL`       |
| LUNA     | `luna-338221784` | `Hotel Padma Bali Boutique Hotel` |
| ZEPH     | `zeph-470134641` | `Padma Bali Boutique Htl.`        |

Ketiganya diselesaikan lewat **tabel pemetaan**, bukan pencocokan nama saat berjalan. Pencocokan berbasis nama rapuh terhadap variasi penulisan yang justru sengaja ditanam di data uji, biayanya dibayar pada setiap pencarian, dan hasilnya tidak deterministik: dua pencarian yang sama dapat menghasilkan pengelompokan berbeda ketika satu supplier lambat menjawab.

Pemetaannya dibangun dari **kebenaran dasar**, bukan dari tebakan. mock-supplier memakai seed tetap dan mengendalikan properti mana muncul di supplier mana, jadi jawabannya sudah dipegang — dan `GET /admin/catalog` pada mock-supplier menerbitkannya. Mencocokkan nama saat seed akan membekukan kesalahan pencocokan ke dalam basis data **sebagai kebenaran**, dan seluruh pengujian sesudahnya akan mengukur kesalahan itu alih-alih menemukannya.

### Jalur pencarian tidak menyentuh basis data

Tiga lapis, dan pembagiannya disengaja:

```
Postgres → sumber kebenaran, disentuh hanya saat memuat ulang
Redis    → salinan bersama antar instance, ditulis satu kali per muat
Memori   → yang benar-benar dibaca setiap pencarian
```

Lapis ketiga itu yang sering terlewat. Pencarian memanggil pemetaan ratusan kali per permintaan; kalau setiap panggilan menembak Redis, yang dihemat hanyalah beban Postgres sementara perjalanan jaringannya tetap ratusan kali.

Karena itu `CatalogSnapshot` **sinkron** — bentuk tipenya sendiri yang menutup kemungkinan memanggil apa pun lewat jaringan dari dalamnya.

Dibuktikan dengan **menghitung pembacaan**, bukan mengukur waktu:

```ts
const result = resolveProperties(SNAPSHOT, items /* 500 */, buffer)

expect(world.properties.calls.reads).toBe(0)
expect(world.mappings.calls.reads).toBe(0)
expect(world.unmapped.calls.writes).toBe(0)
```

Pengukuran waktu akan lulus pada mesin cepat meski setiap pemetaan menembak Postgres.

Pencatatan properti belum terpetakan juga tidak ditunggu: kemunculan dikumpulkan di memori — digabung lebih dulu, karena satu pencarian dapat memunculkan properti yang sama dari lima supplier — lalu disiram berkala.

### Properti belum terpetakan tetap ditampilkan

**Tidak disembunyikan.** Menyembunyikannya berarti kehilangan inventaris, dan agregator yang membuang inventaris karena pemetaannya belum ada sedang merugikan dirinya sendiri demi kerapian basis data.

Ia tampil apa adanya dengan data mentah supplier, ditandai, dan **tanpa slug**. Yang menjaganya adalah tipe:

```ts
type SearchProperty =
  | { kind: 'mapped'; property: Property }
  | { kind: 'unmapped'; supplierId: string; name: string /* tidak ada slug */ }
```

Union, bukan satu bentuk dengan slug opsional. Slug opsional akan menggoda pemanggil menuliskan `property.slug ?? property.id`, yang menghasilkan URL yang berubah begitu pemetaannya ada.

Setiap kemunculan menaikkan penghitung. Antrian operator diurutkan menurut penghitung itu: properti yang sering muncul merugikan paling banyak pencarian, dan memetakannya memberi hasil terbesar per menit kerja operator.

### Slug bersifat permanen

Nama properti berubah — hotel berganti merek, supplier memperbaiki ejaan, operator merapikan kapitalisasi. **Slug tidak ikut berubah.**

Kalau ia ikut berubah, setiap URL yang sudah terindeks mesin pencari, sudah dibagikan di pesan, dan sudah tersimpan di penanda buku menjadi 404. Peringkat pencarian yang dibangun berbulan-bulan hilang dalam satu kali penyuntingan nama — dan PRD Bab 12 mewajibkan halaman properti dapat diindeks.

Ditegakkan di dua tempat: `buildSeedPlan` memakai slug lama untuk properti yang sudah ada, dan `upsertMany` tidak menyertakan kolom `slug` dalam bagian `update`-nya.

Pembedanya angka berurutan, bukan potongan UUID. Dua hotel bernama sama di kota yang sama memang ada, dan `ibis-bandung-2` masih terbaca manusia, masih dapat diketik, dan masih masuk akal ketika muncul di hasil mesin pencari.

### Autocomplete (FR-08)

Full-text PostgreSQL, bukan Elasticsearch. Katalog ini ratusan baris dan jarang berubah; menambah satu sistem pencarian lagi berarti menambah satu sumber kegagalan dan satu salinan data yang harus dijaga tetap sinkron — untuk tabel yang muat di memori. Lihat PRD Bab 12.

Dua indeks, melayani dua bentuk kueri yang berbeda:

| Indeks             | Untuk                               |
| ------------------ | ----------------------------------- |
| GIN `to_tsvector`  | kata utuh, dengan peringkat         |
| GIN `gin_trgm_ops` | awalan — ketikan yang belum selesai |

`to_tsvector` mencocokkan kata utuh, sedangkan autocomplete harus menjawab sejak huruf ketiga, dan pada huruf ketiga belum ada satu pun kata utuh untuk dicocokkan.

Konfigurasi `simple`, bukan `english`: nama hotel Indonesia bukan bahasa Inggris, dan stemming Inggris atas "Padma" atau "Kirana" hanya merusak pencocokan.

Kota **disimpulkan dari properti yang cocok**, bukan dari tabel kota tersendiri. Kota tanpa satu pun properti tidak berguna sebagai saran: pengguna yang memilihnya mendapat hasil kosong.

## Menjalankan

```bash
cp apps/search-service/.env.example apps/search-service/.env
pnpm infra:up
pnpm --filter @tbe/search-service db:migrate
pnpm --filter @tbe/mock-supplier dev
pnpm --filter @tbe/search-service db:seed

# Pencarian memanggil keduanya; tanpa mereka, hasilnya selalu kosong
pnpm --filter @tbe/supplier-service dev
pnpm --filter @tbe/pricing-service dev

pnpm --filter @tbe/search-service dev
```

mock-supplier harus menyala **sebelum** seed: kebenaran dasar katalog dibaca darinya. Seed idempoten — dijalankan dua kali tidak menggandakan apa pun dan tidak mengubah satu pun slug.

Service menyatakan dirinya **belum siap** tanpa katalog. Itu disengaja: tanpa katalog, setiap properti dari setiap supplier tampil sebagai belum terpetakan — hasil yang secara teknis benar, terlihat berfungsi, dan seluruhnya salah, karena satu hotel muncul lima kali tanpa satu pun URL yang dapat dibuka.

## Antarmuka

| Metode | Rute                                | Untuk                                  |
| ------ | ----------------------------------- | -------------------------------------- |
| `GET`  | `/catalog/suggest?q=`               | Saran kota dan properti (FR-08)        |
| `GET`  | `/catalog/properties/:slug`         | Halaman properti, dilayani dari memori |
| `GET`  | `/internal/catalog/unmapped`        | Antrian operator, terurut kemunculan   |
| `POST` | `/internal/catalog/unmapped/map`    | Petakan ke properti yang sudah ada     |
| `POST` | `/internal/catalog/unmapped/create` | Buat properti baru dari data mentah    |

Rute `/internal/*` dilindungi peran operator **di api-gateway**, bukan di sini.

Zona waktu **wajib** saat membuat properti, bukan opsional dengan bawaan. Bawaan `Asia/Jakarta` akan benar untuk sebagian besar properti dan salah diam-diam untuk Bali dan luar negeri — lalu Step 25 menghitung tenggat pembatalan dengan zona waktu yang keliru, dan selisihnya berarti pengembalian dana yang seharusnya tidak terjadi.

## Uji

```bash
pnpm --filter @tbe/search-service test
```

258 test, cakupan 94,7% pernyataan. Uji HTTP dirangkai lewat factory yang sama dengan produksi — hanya port-nya yang dipalsukan.

Tidak satu pun uji di service ini mengukur waktu atau memanggil `setTimeout`. Anggaran waktu, supplier lambat, dan seratus permintaan serentak semuanya dikendalikan tangan lewat port — uji yang bergantung pada jam mesin menguji jamnya, bukan kodenya.
