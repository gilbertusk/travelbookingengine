-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "analytics_counters" (
    "day" DATE NOT NULL,
    "metric" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "value" BIGINT NOT NULL,

    CONSTRAINT "analytics_counters_pkey" PRIMARY KEY ("day","metric","dimension")
);

-- CreateTable
CREATE TABLE "analytics_processed_events" (
    "event_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "analytics_processed_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "analytics_booking_suppliers" (
    "booking_id" UUID NOT NULL,
    "supplier" TEXT NOT NULL,

    CONSTRAINT "analytics_booking_suppliers_pkey" PRIMARY KEY ("booking_id")
);

-- CreateIndex
CREATE INDEX "analytics_counters_metric_day_idx" ON "analytics_counters"("metric", "day");


-- ---------------------------------------------------------------------------
-- Ditulis tangan, di luar yang dihasilkan `prisma migrate diff`.
-- ---------------------------------------------------------------------------

-- Penghitung hanya pernah DITAMBAH bilangan non-negatif (domain/counters.ts).
-- Nilai negatif berarti penulis lain atau sunting tangan yang salah; ditolak
-- di sini supaya laporan tidak pernah menampilkan "-3 pencarian".
ALTER TABLE "analytics_counters"
  ADD CONSTRAINT "analytics_counters_value_nonnegative" CHECK ("value" >= 0);

-- Metrik tidak pernah kosong; dimensi boleh kosong (''), tidak boleh NULL —
-- NOT NULL di atas sudah menjamin yang kedua.
ALTER TABLE "analytics_counters"
  ADD CONSTRAINT "analytics_counters_metric_present" CHECK ("metric" <> '');
