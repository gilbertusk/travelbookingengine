-- Step 25: nilai enum untuk pembatalan oleh pengguna.
--
-- Terpisah dari migrasi kolom dan batasannya karena Postgres menolak memakai
-- nilai enum yang baru ditambahkan di dalam transaksi yang sama — dan batasan
-- CHECK di migrasi berikutnya menyebut 'CANCELLING'.

-- AlterEnum
ALTER TYPE "booking_status" ADD VALUE 'CANCELLING' AFTER 'CONFIRMED';

-- AlterEnum
ALTER TYPE "booking_event_type" ADD VALUE 'CancellationRequested';
ALTER TYPE "booking_event_type" ADD VALUE 'SupplierCancellationConfirmed';
ALTER TYPE "booking_event_type" ADD VALUE 'CancellationRestored';
ALTER TYPE "booking_event_type" ADD VALUE 'CancellationCompleted';

-- CreateEnum
CREATE TYPE "cancellation_step" AS ENUM ('supplier', 'refund');
