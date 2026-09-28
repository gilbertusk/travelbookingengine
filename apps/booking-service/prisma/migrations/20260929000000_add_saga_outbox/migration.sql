-- Step 19: saga_states, outbox, dan consumed_messages.
--
-- Ketiganya ditulis dalam transaksi yang sama dengan bookings dan
-- booking_events bila perubahan keadaan menyertainya. Migrasi lama TIDAK
-- diubah; semua yang baru ada di sini.

-- CreateEnum
CREATE TYPE "saga_step" AS ENUM ('priceCheck', 'holdLocal', 'holdSupplier', 'awaitPayment', 'confirmSupplier', 'issueVoucher');

-- CreateEnum
CREATE TYPE "saga_step_status" AS ENUM ('started', 'waiting', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "compensation_status" AS ENUM ('none', 'running', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "outbox_channel" AS ENUM ('kafka', 'rabbitmq');

-- CreateTable
CREATE TABLE "saga_states" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "current_step" "saga_step" NOT NULL,
    "step_status" "saga_step_status" NOT NULL,
    "compensation_status" "compensation_status" NOT NULL,
    "compensating_step" "saga_step",
    "attempts" INTEGER NOT NULL,
    "last_error" TEXT,
    "deadline_at" TIMESTAMPTZ(3),
    "leased_until" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "saga_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox" (
    "id" UUID NOT NULL,
    "sequence" BIGSERIAL NOT NULL,
    "booking_id" UUID NOT NULL,
    "channel" "outbox_channel" NOT NULL,
    "message_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "causation_id" UUID,
    "traceparent" TEXT,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "published_at" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "rejected_at" TIMESTAMPTZ(3),

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consumed_messages" (
    "event_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "booking_id" UUID NOT NULL,
    "consumed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "consumed_messages_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "saga_states_booking_id_key" ON "saga_states"("booking_id");

-- CreateIndex
CREATE INDEX "saga_states_deadline_at_idx" ON "saga_states"("deadline_at");

-- CreateIndex
CREATE INDEX "saga_states_leased_until_idx" ON "saga_states"("leased_until");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_sequence_key" ON "outbox"("sequence");

-- CreateIndex
CREATE INDEX "outbox_published_at_sequence_idx" ON "outbox"("published_at", "sequence");

-- AddForeignKey
ALTER TABLE "saga_states" ADD CONSTRAINT "saga_states_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Ditambahkan tangan: aturan yang tidak dapat dinyatakan schema.prisma.
--
-- Semua di atas garis ini dihasilkan oleh
--   prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
-- terhadap basis data hasil kedua migrasi sebelumnya, dan tidak diubah.
-- Semua di bawahnya ditulis tangan. Diuji terhadap PostgreSQL 16 sungguhan di
-- tests/integration/saga-schema.test.ts.
-- ---------------------------------------------------------------------------

ALTER TABLE "saga_states" ADD CONSTRAINT "saga_states_attempts_check"
  CHECK ("attempts" >= 0);

ALTER TABLE "saga_states" ADD CONSTRAINT "saga_states_version_positive_check"
  CHECK ("version" >= 1);

-- Langkah langsung yang sedang dikerjakan WAJIB punya sewa. Tanpa sewa,
-- pemulihan tidak pernah tahu kapan prosesnya boleh dianggap mati, dan saga
-- yang prosesnya mati di tengah hold menggantung selamanya (NFR-06).
ALTER TABLE "saga_states" ADD CONSTRAINT "saga_states_started_has_lease_check"
  CHECK ("step_status" <> 'started' OR "leased_until" IS NOT NULL);

-- Menunggu jawaban supplier WAJIB punya batas waktu. Jawaban yang tidak
-- pernah datang — supplier-service mati, pesan hilang — tanpa batas waktu
-- adalah pemesanan berbayar yang menggantung selamanya.
ALTER TABLE "saga_states" ADD CONSTRAINT "saga_states_confirm_has_deadline_check"
  CHECK (
    NOT ("current_step" = 'confirmSupplier' AND "step_status" = 'waiting')
    OR "deadline_at" IS NOT NULL
  );

-- Penunjuk kompensasi hanya bermakna selama kompensasi berjalan.
ALTER TABLE "saga_states" ADD CONSTRAINT "saga_states_pointer_only_while_compensating_check"
  CHECK ("compensating_step" IS NULL OR "compensation_status" = 'running');

ALTER TABLE "outbox" ADD CONSTRAINT "outbox_attempts_check"
  CHECK ("attempts" >= 0);

-- Pesan tidak dapat terbit DAN ditolak sekaligus.
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_published_or_rejected_check"
  CHECK ("published_at" IS NULL OR "rejected_at" IS NULL);
