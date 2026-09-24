# search-service

Katalog properti dan pemetaan supplier. Fan-out pencarian menyusul pada Step 13.

Memenuhi FR-04, FR-08, dan FR-30. Konsekuensi langsung [ADR-0001](../../docs/adr/0001-identitas-properti-lintas-supplier.md).

## Batas yang tidak boleh dilanggar

**Katalog menyimpan data statis saja. Harga dan ketersediaan tidak pernah disimpan.**

Melanggarnya tidak menggagalkan apa pun hari itu juga, dan justru itulah bahayanya. Satu kolom `lowestPrice` terasa praktis saat ditambahkan — ia menghemat satu panggilan, halamannya terasa lebih cepat, dan tidak ada satu pun uji yang gagal. Yang terjadi kemudian: angka itu basi dalam hitungan menit, pengguna melihat harga yang tidak ada lagi, lalu pemesanannya ditolak saat pembayaran. Itu kegagalan produk yang paling merusak kepercayaan.

Komentar di `schema.prisma` tidak menghentikan siapa pun. Skrip ini bisa:

```bash
pnpm verify:catalog
```

Ia memeriksa ketiga model katalog untuk kolom bernama harga atau ketersediaan, dan menolak berjalan kalau modelnya sudah berganti nama — skrip yang memeriksa model yang tidak ada lagi akan lulus karena buta, bukan karena bersih.

## Deduplikasi adalah pencarian di tabel

Satu hotel fisik dijual beberapa supplier dengan pengenal, ejaan nama, dan harga berbeda:

| Supplier | Pengenal         | Nama                              |
| -------- | ---------------- | --------------------------------- |
| SKY      | `sky-120804930`  | `Padma Bali Boutique Hotel`       |
| NOVA     | `nova-345515035` | `PADMA BALI BOUTIQUE HOTEL`       |
| LUNA     | `luna-338221784` | `Hotel Padma Bali Boutique Hotel` |
| ZEPH     | `zeph-470134641` | `Padma Bali Boutique Htl.`        |

Ketiganya diselesaikan lewat **tabel pemetaan**, bukan pencocokan nama saat berjalan. Pencocokan berbasis nama rapuh terhadap variasi penulisan yang justru sengaja ditanam di data uji, biayanya dibayar pada setiap pencarian, dan hasilnya tidak deterministik: dua pencarian yang sama dapat menghasilkan pengelompokan berbeda ketika satu supplier lambat menjawab.

Pemetaannya dibangun dari **kebenaran dasar**, bukan dari tebakan. mock-supplier memakai seed tetap dan mengendalikan properti mana muncul di supplier mana, jadi jawabannya sudah dipegang — dan `GET /admin/catalog` pada mock-supplier menerbitkannya. Mencocokkan nama saat seed akan membekukan kesalahan pencocokan ke dalam basis data **sebagai kebenaran**, dan seluruh pengujian sesudahnya akan mengukur kesalahan itu alih-alih menemukannya.

## Jalur pencarian tidak menyentuh basis data

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

## Properti belum terpetakan tetap ditampilkan

**Tidak disembunyikan.** Menyembunyikannya berarti kehilangan inventaris, dan agregator yang membuang inventaris karena pemetaannya belum ada sedang merugikan dirinya sendiri demi kerapian basis data.

Ia tampil apa adanya dengan data mentah supplier, ditandai, dan **tanpa slug**. Yang menjaganya adalah tipe:

```ts
type SearchProperty =
  | { kind: 'mapped'; property: Property }
  | { kind: 'unmapped'; supplierId: string; name: string /* tidak ada slug */ }
```

Union, bukan satu bentuk dengan slug opsional. Slug opsional akan menggoda pemanggil menuliskan `property.slug ?? property.id`, yang menghasilkan URL yang berubah begitu pemetaannya ada.

Setiap kemunculan menaikkan penghitung. Antrian operator diurutkan menurut penghitung itu: properti yang sering muncul merugikan paling banyak pencarian, dan memetakannya memberi hasil terbesar per menit kerja operator.

## Slug bersifat permanen

Nama properti berubah — hotel berganti merek, supplier memperbaiki ejaan, operator merapikan kapitalisasi. **Slug tidak ikut berubah.**

Kalau ia ikut berubah, setiap URL yang sudah terindeks mesin pencari, sudah dibagikan di pesan, dan sudah tersimpan di penanda buku menjadi 404. Peringkat pencarian yang dibangun berbulan-bulan hilang dalam satu kali penyuntingan nama — dan PRD Bab 12 mewajibkan halaman properti dapat diindeks.

Ditegakkan di dua tempat: `buildSeedPlan` memakai slug lama untuk properti yang sudah ada, dan `upsertMany` tidak menyertakan kolom `slug` dalam bagian `update`-nya.

Pembedanya angka berurutan, bukan potongan UUID. Dua hotel bernama sama di kota yang sama memang ada, dan `ibis-bandung-2` masih terbaca manusia, masih dapat diketik, dan masih masuk akal ketika muncul di hasil mesin pencari.

## Autocomplete (FR-08)

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

118 test, cakupan 99,5% pernyataan. Uji HTTP dirangkai lewat factory yang sama dengan produksi — hanya port-nya yang dipalsukan.
