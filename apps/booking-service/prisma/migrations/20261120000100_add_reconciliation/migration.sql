-- Step 28: rekonsiliasi dengan supplier (FR-33).
--
-- Putaran dan temuannya. Pemesanan yang tidak cocok dipindahkan ke
-- NEEDS_REVIEW lewat transisi domain biasa (jejak di booking_events); tabel
-- ini adalah LAPORANNYA untuk panel operator, bukan sumber kebenaran keadaan.
-- CreateTable
CREATE TABLE "reconciliation_runs" (
    "id" UUID NOT NULL,
    "day" VARCHAR(10) NOT NULL,
    "supplier" VARCHAR(8),
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "finished_at" TIMESTAMPTZ(3),
    "checked" INTEGER NOT NULL DEFAULT 0,
    "matched" INTEGER NOT NULL DEFAULT 0,
    "mismatched" INTEGER NOT NULL DEFAULT 0,
    "unverified" INTEGER NOT NULL DEFAULT 0,
    "flagged" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "reconciliation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_findings" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "supplier" VARCHAR(8) NOT NULL,
    "local_status" "booking_status" NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "detail" TEXT NOT NULL,
    "flagged" BOOLEAN NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reconciliation_findings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reconciliation_runs_started_at_idx" ON "reconciliation_runs"("started_at");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_findings_run_id_booking_id_key" ON "reconciliation_findings"("run_id", "booking_id");

-- AddForeignKey
ALTER TABLE "reconciliation_findings" ADD CONSTRAINT "reconciliation_findings_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "reconciliation_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Tulisan tangan: penghitung tidak pernah negatif, dan hanya jenis temuan
-- yang dikenal domain (MISMATCH_KINDS ditambah `unverified`) yang tersimpan.
ALTER TABLE "reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_counts_nonnegative"
  CHECK ("checked" >= 0 AND "matched" >= 0 AND "mismatched" >= 0 AND "unverified" >= 0 AND "flagged" >= 0);
ALTER TABLE "reconciliation_findings" ADD CONSTRAINT "reconciliation_findings_kind_known"
  CHECK ("kind" IN ('missing_at_supplier', 'cancelled_at_supplier', 'active_at_supplier', 'amount_mismatch', 'dates_mismatch', 'unverified'));
