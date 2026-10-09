-- Step 23: kontak properti untuk e-voucher.
--
-- Nullable, bukan NOT NULL dengan bawaan string kosong: properti yang dibuat
-- operator dari antrian belum terpetakan belum tentu punya kontak, dan string
-- kosong di voucher terlihat seperti kontak yang hilang karena cacat, bukan
-- kontak yang memang tidak diketahui. Seed berikutnya mengisi properti yang
-- berasal dari mock-supplier.

-- AlterTable
ALTER TABLE "properties" ADD COLUMN "phone" TEXT,
ADD COLUMN "email" TEXT;
