-- Step 25: pembatalan dan pengembalian dana.
--
-- Jadwal pengembalian disimpan saat harga diverifikasi ke supplier. Baris yang
-- sudah ada diisi `{"tiers": null}` — terang-terangan tidak tercatat — alih-alih
-- mengarang jadwal dari kebijakan yang dulu dikirim peramban. Pembatalan
-- pemesanan seperti itu diserahkan ke manusia.

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN "refund_schedule" JSONB,
ADD COLUMN "cancel_refund_minor" INTEGER,
ADD COLUMN "cancel_refund_currency" TEXT,
ADD COLUMN "cancel_refund_percent" INTEGER,
ADD COLUMN "cancel_requested_at" TIMESTAMPTZ(3),
ADD COLUMN "cancel_step" "cancellation_step",
ADD COLUMN "cancel_deadline_at" TIMESTAMPTZ(3);

UPDATE "bookings" SET "refund_schedule" = '{"tiers": null}'::jsonb WHERE "refund_schedule" IS NULL;

ALTER TABLE "bookings" ALTER COLUMN "refund_schedule" SET NOT NULL;

-- CreateIndex
CREATE INDEX "bookings_status_cancel_deadline_at_idx" ON "bookings"("status", "cancel_deadline_at");

-- ---------------------------------------------------------------------------
-- Ditambahkan tangan: aturan yang tidak dapat dinyatakan schema.prisma.
-- ---------------------------------------------------------------------------

-- CANCELLING tetap menyebut pembayaran dan booking reference yang sedang
-- dibatalkan. Dua batasan Step 16 diperluas, bukan ditambah yang baru.
ALTER TABLE "bookings" DROP CONSTRAINT "bookings_paid_has_payment_check";
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_paid_has_payment_check"
  CHECK (
    "status" NOT IN ('PAID', 'CONFIRMED', 'CANCELLING', 'FAILED', 'REFUNDED', 'NEEDS_REVIEW')
    OR "payment_id" IS NOT NULL
  );

ALTER TABLE "bookings" DROP CONSTRAINT "bookings_confirmed_has_supplier_ref_check";
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_confirmed_has_supplier_ref_check"
  CHECK ("status" NOT IN ('CONFIRMED', 'CANCELLING') OR "supplier_ref" IS NOT NULL);

-- Pembatalan yang sedang berjalan selalu membawa persetujuannya dan langkah
-- yang ditunggunya. CANCELLING tanpa batas waktu tidak akan pernah disapu dan
-- menggantung bersama uang pengguna.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_cancelling_complete_check"
  CHECK (
    "status" <> 'CANCELLING'
    OR ("cancel_refund_minor" IS NOT NULL AND "cancel_refund_currency" IS NOT NULL
        AND "cancel_refund_percent" IS NOT NULL AND "cancel_requested_at" IS NOT NULL
        AND "cancel_step" IS NOT NULL AND "cancel_deadline_at" IS NOT NULL)
  );

-- Langkah dan batas waktunya hanya bermakna selama pembatalan berjalan.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_cancel_step_only_while_cancelling_check"
  CHECK ("status" = 'CANCELLING' OR ("cancel_step" IS NULL AND "cancel_deadline_at" IS NULL));

-- Nilai pengembalian tidak pernah negatif dan tidak pernah melebihi
-- pembayaran; persentasenya bilangan bulat 0–100.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_cancel_refund_bounds_check"
  CHECK (
    "cancel_refund_minor" IS NULL
    OR ("cancel_refund_minor" >= 0 AND "cancel_refund_minor" <= "amount_minor"
        AND "cancel_refund_currency" = "currency")
  );

ALTER TABLE "bookings" ADD CONSTRAINT "bookings_cancel_refund_percent_check"
  CHECK ("cancel_refund_percent" IS NULL OR "cancel_refund_percent" BETWEEN 0 AND 100);
