# Travel Booking Engine

Agregator pemesanan hotel yang menggabungkan inventaris dari beberapa supplier pihak ketiga menjadi satu hasil pencarian, dan menangani alur pemesanan sampai penerbitan e-voucher.

Yang membedakannya dari e-commerce biasa: **inventaris bukan milik sendiri.** Stok berada di pihak ketiga yang lambat, formatnya berbeda-beda, harganya berubah tanpa pemberitahuan, dan sewaktu-waktu bisa mati. Seluruh kompleksitas teknis sistem ini berasal dari kenyataan tersebut.

> Dokumen ini akan dilengkapi dengan bukti terukur, diagram arsitektur, dan tautan demonstrasi pada Step 29. Untuk sekarang isinya baru prasyarat dan cara menjalankan.

## Prasyarat

| Perkakas | Versi                 |
| -------- | --------------------- |
| Node.js  | 24 (lihat `.nvmrc`)   |
| pnpm     | 11+                   |
| Docker   | dengan Docker Compose |

## Menjalankan

```bash
pnpm install
```

Infrastruktur lokal dan service menyusul pada Step 02 dan seterusnya.

## Perintah

| Perintah                 | Kegunaan                                                               |
| ------------------------ | ---------------------------------------------------------------------- |
| `pnpm lint`              | ESLint untuk seluruh repo                                              |
| `pnpm typecheck`         | Pemeriksaan tipe per workspace                                         |
| `pnpm test`              | Uji unit                                                               |
| `pnpm test:integration`  | Uji integrasi dengan Testcontainers                                    |
| `pnpm format`            | Prettier                                                               |
| `pnpm verify:boundaries` | Membuktikan aturan arah ketergantungan benar-benar aktif               |
| `pnpm verify:money`      | Membuktikan tidak ada nilai uang bertipe `number` maupun kolom pecahan |
| `pnpm verify:catalog`    | Membuktikan katalog tidak menyimpan harga maupun ketersediaan          |
| `pnpm verify:tokens`     | Membuktikan komponen hanya memakai token desain                        |
| `pnpm verify:contrast`   | Membuktikan setiap pasangan warna memenuhi WCAG AA                     |

## Struktur

```
apps/        Service backend dan aplikasi frontend
packages/    Kode bersama lintas workspace
infra/       Docker Compose, konfigurasi observability, skenario uji beban
docs/
  plan/      Playbook implementasi per step
  adr/       Catatan keputusan arsitektur
  evidence/  Hasil uji beban dan chaos
.claude/
  prds/      Dokumen kebutuhan produk
```

## Dokumen

| Dokumen                                          | Isi                                                          |
| ------------------------------------------------ | ------------------------------------------------------------ |
| [PRD](.claude/prds/travel-booking-engine.prd.md) | Kebutuhan, metrik keberhasilan, glosarium domain, keputusan  |
| [Playbook](docs/plan/README.md)                  | 31 step implementasi, masing-masing dengan definisi selesai  |
| [Konvensi kode](docs/plan/CONVENTIONS.md)        | Struktur layanan, arah ketergantungan, batas ukuran, testing |
| [Design system](docs/plan/DESIGN-SYSTEM.md)      | Token, tipografi, komponen, aksesibilitas                    |
