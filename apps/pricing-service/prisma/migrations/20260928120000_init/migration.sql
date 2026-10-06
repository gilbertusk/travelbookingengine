-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "markup_kind" AS ENUM ('percentage', 'fixed');

-- CreateTable
CREATE TABLE "markup_rules" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "supplier" TEXT,
    "city" TEXT,
    "kind" "markup_kind" NOT NULL,
    "percentage_basis_points" INTEGER,
    "fixed_amount_minor" INTEGER,
    "fixed_currency" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "markup_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_rates" (
    "id" UUID NOT NULL,
    "from_currency" TEXT NOT NULL,
    "to_currency" TEXT NOT NULL,
    "rate" INTEGER NOT NULL,
    "scale" INTEGER NOT NULL DEFAULT 0,
    "effective_from" TIMESTAMPTZ(3) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'static',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "markup_rules_is_active_priority_idx" ON "markup_rules"("is_active", "priority");

-- CreateIndex
CREATE INDEX "exchange_rates_from_currency_to_currency_effective_from_idx" ON "exchange_rates"("from_currency", "to_currency", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "exchange_rates_from_currency_to_currency_effective_from_key" ON "exchange_rates"("from_currency", "to_currency", "effective_from");

