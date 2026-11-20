-- Step 28: pemesanan yang ditinggalkan sebelum hold.
--
-- Alasan pembatalan `abandoned`, dan indeks (status, updated_at) untuk
-- penyapunya — juga dipakai rekonsiliasi untuk memilih pemesanan menurut
-- keadaan dan umur perubahan terakhirnya.

-- AlterEnum
ALTER TYPE "cancellation_reason" ADD VALUE 'abandoned';

-- CreateIndex
CREATE INDEX "bookings_status_updated_at_idx" ON "bookings"("status", "updated_at");
