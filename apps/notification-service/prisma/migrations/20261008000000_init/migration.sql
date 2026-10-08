-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "notification_type" AS ENUM ('booking_confirmed', 'booking_failed', 'booking_cancelled', 'refund_completed', 'manual_review');

-- CreateEnum
CREATE TYPE "notification_channel" AS ENUM ('email');

-- CreateEnum
CREATE TYPE "notification_status" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED', 'DEAD');

-- CreateEnum
CREATE TYPE "notification_source" AS ENUM ('event', 'command');

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "user_id" UUID,
    "type" "notification_type" NOT NULL,
    "channel" "notification_channel" NOT NULL DEFAULT 'email',
    "status" "notification_status" NOT NULL DEFAULT 'PENDING',
    "dedupe_key" TEXT NOT NULL,
    "source" "notification_source" NOT NULL,
    "source_message_id" UUID NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "context" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL,
    "lease_until" TIMESTAMPTZ(3),
    "recipient_key" TEXT,
    "last_error" TEXT,
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notifications_dedupe_key_key" ON "notifications"("dedupe_key");

-- CreateIndex
CREATE INDEX "notifications_recipient_key_sent_at_idx" ON "notifications"("recipient_key", "sent_at");

-- CreateIndex
CREATE INDEX "notifications_booking_id_idx" ON "notifications"("booking_id");


-- Antrian penghantar: hanya baris yang masih menunggu atau sedang disewa yang
-- pernah dicari. Indeks parsial menjaganya tetap kecil sementara baris SENT
-- menumpuk.
CREATE INDEX "notifications_due_idx" ON "notifications"("next_attempt_at")
    WHERE "status" IN ('PENDING', 'SENDING');

-- Percobaan tidak pernah negatif; surel terkirim selalu punya waktu kirim.
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_attempts_nonnegative" CHECK ("attempts" >= 0);
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_sent_has_time"
    CHECK ("status" <> 'SENT' OR "sent_at" IS NOT NULL);
