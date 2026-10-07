-- Step 23: ketentuan tawaran sebagai bahan e-voucher.
--
-- Baris yang sudah ada sebelum Step 23 tidak punya ketentuan yang tercatat.
-- Mereka diisi `{"terms": null}` — pernyataan terang-terangan bahwa tidak ada
-- yang tercatat — alih-alih mengarang kebijakan pembatalan yang tidak pernah
-- dilihat pengguna. Sesudahnya kolom wajib dan tanpa nilai bawaan: setiap
-- pemesanan baru menuliskannya sendiri.

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN "offer_terms" JSONB;

UPDATE "bookings" SET "offer_terms" = '{"terms": null}'::jsonb WHERE "offer_terms" IS NULL;

ALTER TABLE "bookings" ALTER COLUMN "offer_terms" SET NOT NULL;
