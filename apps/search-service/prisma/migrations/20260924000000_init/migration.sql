-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "properties" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "country_code" CHAR(2) NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "timezone" TEXT NOT NULL,
    "star_rating" INTEGER NOT NULL,
    "amenities" TEXT[],
    "description" TEXT,
    "photos" TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "properties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_property_mappings" (
    "id" UUID NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "supplier_property_id" TEXT NOT NULL,
    "property_id" UUID NOT NULL,
    "confidence" INTEGER NOT NULL DEFAULT 10000,
    "mapped_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mapped_by" TEXT NOT NULL,

    CONSTRAINT "supplier_property_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unmapped_properties" (
    "id" UUID NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "supplier_property_id" TEXT NOT NULL,
    "raw_name" TEXT NOT NULL,
    "raw_address" TEXT,
    "raw_city" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "resolved_at" TIMESTAMPTZ(3),

    CONSTRAINT "unmapped_properties_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "properties_slug_key" ON "properties"("slug");

-- CreateIndex
CREATE INDEX "properties_city_idx" ON "properties"("city");

-- CreateIndex
CREATE INDEX "supplier_property_mappings_property_id_idx" ON "supplier_property_mappings"("property_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_property_mappings_supplier_id_supplier_property_id_key" ON "supplier_property_mappings"("supplier_id", "supplier_property_id");

-- CreateIndex
CREATE INDEX "unmapped_properties_resolved_at_occurrences_idx" ON "unmapped_properties"("resolved_at", "occurrences");

-- CreateIndex
CREATE UNIQUE INDEX "unmapped_properties_supplier_id_supplier_property_id_key" ON "unmapped_properties"("supplier_id", "supplier_property_id");

-- AddForeignKey
ALTER TABLE "supplier_property_mappings" ADD CONSTRAINT "supplier_property_mappings_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Full-text search untuk autocomplete (FR-08).
--
-- Ditulis tangan karena Prisma tidak dapat menyatakan indeks GIN atas
-- ekspresi tsvector. Tanpa indeks ini, setiap ketikan di kotak pencarian
-- memicu pemindaian seluruh tabel — yang pada 320 baris tetap cepat, dan
-- karena itu tidak akan ketahuan sampai katalognya tumbuh.
--
-- Bukan Elasticsearch. Katalog ini kecil dan jarang berubah; menambah satu
-- sistem pencarian lagi berarti menambah satu sumber kegagalan dan satu
-- salinan data yang harus dijaga tetap sinkron. Lihat PRD Bab 12.
--
-- `simple` dipakai, bukan `english`: nama hotel Indonesia bukan bahasa Inggris,
-- dan stemming Inggris atas "Padma" atau "Kirana" hanya merusak pencocokan.
CREATE INDEX "properties_fts_idx" ON "properties"
  USING GIN (to_tsvector('simple', "name" || ' ' || "city"));

-- Pencocokan awalan untuk ketikan pendek. `to_tsvector` mencocokkan kata utuh,
-- sedangkan autocomplete harus menjawab sejak huruf ketiga — dua indeks ini
-- melayani dua bentuk kueri yang berbeda, dan keduanya dibutuhkan.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "properties_name_trgm_idx" ON "properties" USING GIN ("normalized_name" gin_trgm_ops);
CREATE INDEX "properties_city_trgm_idx" ON "properties" USING GIN (lower("city") gin_trgm_ops);
