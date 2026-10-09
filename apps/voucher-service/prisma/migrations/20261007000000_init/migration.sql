-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "vouchers" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "object_key" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL,
    "confirmed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vouchers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vouchers_booking_id_key" ON "vouchers"("booking_id");

-- CreateIndex
CREATE UNIQUE INDEX "vouchers_object_key_key" ON "vouchers"("object_key");

-- CreateIndex
CREATE INDEX "vouchers_user_id_idx" ON "vouchers"("user_id");

-- Ukuran berkas yang tidak positif bukan voucher.
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_size_bytes_positive" CHECK ("size_bytes" > 0);
