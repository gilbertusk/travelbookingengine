-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "supplier_operation" AS ENUM ('search', 'priceCheck', 'hold', 'book', 'cancel', 'getBooking');

-- CreateEnum
CREATE TYPE "request_outcome" AS ENUM ('success', 'failure');

-- CreateTable
CREATE TABLE "suppliers" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "adapter" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "credential_ref" TEXT,
    "timeouts" JSONB NOT NULL DEFAULT '{}',
    "circuit_failure_threshold" INTEGER NOT NULL DEFAULT 5,
    "circuit_window_seconds" INTEGER NOT NULL DEFAULT 60,
    "circuit_open_seconds" INTEGER NOT NULL DEFAULT 30,
    "rate_limit_per_second" INTEGER NOT NULL DEFAULT 20,
    "rate_limit_burst" INTEGER NOT NULL DEFAULT 40,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "supplier_requests" (
    "id" UUID NOT NULL,
    "supplier_code" TEXT NOT NULL,
    "operation" "supplier_operation" NOT NULL,
    "outcome" "request_outcome" NOT NULL,
    "error_kind" TEXT,
    "attempt_number" INTEGER NOT NULL,
    "request_payload" JSONB,
    "response_payload" JSONB,
    "latency_ms" INTEGER NOT NULL,
    "idempotency_key" TEXT,
    "correlation_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "supplier_requests_idempotency_key_idx" ON "supplier_requests"("idempotency_key");

-- CreateIndex
CREATE INDEX "supplier_requests_supplier_code_created_at_idx" ON "supplier_requests"("supplier_code", "created_at");

-- AddForeignKey
ALTER TABLE "supplier_requests" ADD CONSTRAINT "supplier_requests_supplier_code_fkey" FOREIGN KEY ("supplier_code") REFERENCES "suppliers"("code") ON DELETE CASCADE ON UPDATE CASCADE;

