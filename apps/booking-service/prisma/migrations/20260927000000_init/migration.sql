-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "booking_status" AS ENUM ('DRAFT', 'PRICE_CHECKED', 'HELD', 'PAID', 'CONFIRMED', 'FAILED', 'REFUNDED', 'CANCELLED', 'EXPIRED', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "price_check_outcome" AS ENUM ('verified', 'changed', 'accepted');

-- CreateEnum
CREATE TYPE "cancellation_reason" AS ENUM ('user_request', 'payment_failed', 'supplier_rejected');

-- CreateEnum
CREATE TYPE "booking_event_type" AS ENUM ('BookingCreated', 'PriceVerified', 'PriceChanged', 'PriceAccepted', 'BookingHeld', 'HoldExpired', 'PaymentRecorded', 'BookingConfirmed', 'BookingFailed', 'BookingRefunded', 'BookingCancelled', 'ReviewRequired');

-- CreateTable
CREATE TABLE "bookings" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "booking_status" NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "rate_plan_ref" TEXT NOT NULL,
    "check_in" DATE NOT NULL,
    "check_out" DATE NOT NULL,
    "guests" INTEGER NOT NULL,
    "lead_guest_name" TEXT NOT NULL,
    "lead_guest_email" TEXT NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "price_check" "price_check_outcome",
    "quoted_amount_minor" INTEGER,
    "quoted_currency" TEXT,
    "price_lines" JSONB NOT NULL,
    "hold_ref" TEXT,
    "held_until" TIMESTAMPTZ(3),
    "payment_id" UUID,
    "supplier_ref" TEXT,
    "refund_id" UUID,
    "failure_reason" TEXT,
    "cancellation" "cancellation_reason",
    "review_reason" TEXT,
    "review_from" "booking_status",
    "idempotency_key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_events" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "event_type" "booking_event_type" NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "booking_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bookings_status_held_until_idx" ON "bookings"("status", "held_until");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_user_id_idempotency_key_key" ON "bookings"("user_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "booking_events_booking_id_sequence_key" ON "booking_events"("booking_id", "sequence");

-- AddForeignKey
ALTER TABLE "booking_events" ADD CONSTRAINT "booking_events_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Ditambahkan tangan: aturan yang tidak dapat dinyatakan schema.prisma.
--
-- Semua di atas garis ini dihasilkan offline oleh
--   prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script
-- dan tidak diubah. Semua di bawahnya ditulis tangan, dan BELUM PERNAH
-- dijalankan terhadap Postgres sungguhan (Docker mati sejak Step 05) — lihat
-- README bagian "Perintah verifikasi yang BELUM dijalankan".
-- ---------------------------------------------------------------------------

-- Pertahanan berlapis untuk union diskriminan di src/domain/booking.ts. Domain
-- sudah menolak data pada keadaan yang salah lewat compiler; batasan ini
-- menolaknya pada tingkat basis data, untuk penulis yang bukan domain: skrip
-- perbaikan data, psql, dan migrasi berikutnya.

-- Check-out setelah check-in. Pembandingan DATE, tanpa zona waktu apa pun.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_stay_order_check"
  CHECK ("check_out" > "check_in");

ALTER TABLE "bookings" ADD CONSTRAINT "bookings_amount_positive_check"
  CHECK ("amount_minor" > 0);

ALTER TABLE "bookings" ADD CONSTRAINT "bookings_version_positive_check"
  CHECK ("version" >= 1);

-- CONFIRMED tanpa booking reference adalah pemesanan tanpa bukti (FR-24).
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_confirmed_has_supplier_ref_check"
  CHECK ("status" <> 'CONFIRMED' OR "supplier_ref" IS NOT NULL);

-- DRAFT belum punya apa-apa: tidak ada hold, pembayaran, maupun booking reference.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_draft_is_bare_check"
  CHECK (
    "status" <> 'DRAFT'
    OR ("hold_ref" IS NULL AND "held_until" IS NULL AND "payment_id" IS NULL
        AND "supplier_ref" IS NULL AND "refund_id" IS NULL)
  );

-- Hold selalu membawa tokennya dan batas waktunya. Penyapu Step 17 membaca
-- held_until; HELD tanpa held_until tidak akan pernah disapu dan menggantung.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_hold_complete_check"
  CHECK (
    "status" NOT IN ('HELD', 'EXPIRED')
    OR ("hold_ref" IS NOT NULL AND "held_until" IS NOT NULL)
  );

-- Setiap keadaan sesudah pembayaran menyebut pembayarannya.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_paid_has_payment_check"
  CHECK (
    "status" NOT IN ('PAID', 'CONFIRMED', 'FAILED', 'REFUNDED', 'NEEDS_REVIEW')
    OR "payment_id" IS NOT NULL
  );

-- booking_events HANYA BERTAMBAH (NFR-10).
--
-- Port repository tidak punya operasi ubah atau hapus peristiwa, tetapi port
-- hanya mengikat kode yang memakainya. Trigger ini mengikat semua penulis.
-- TRUNCATE ditolak terpisah karena ia tidak memicu trigger baris.
CREATE FUNCTION "booking_events_append_only"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'booking_events hanya bertambah: % ditolak', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "booking_events_no_update_or_delete"
  BEFORE UPDATE OR DELETE ON "booking_events"
  FOR EACH ROW EXECUTE FUNCTION "booking_events_append_only"();

CREATE TRIGGER "booking_events_no_truncate"
  BEFORE TRUNCATE ON "booking_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "booking_events_append_only"();
