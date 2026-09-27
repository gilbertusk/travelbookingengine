-- Kota properti, cakupan aturan markup pricing-service (Step 17).
--
-- NOT NULL tanpa nilai bawaan: booking-service belum pernah dikerahkan, jadi
-- tidak ada baris yang perlu diisi. Pada basis data yang sudah berisi, migrasi
-- ini gagal dengan sengaja — kota tidak dapat ditebak dari property_id di sini,
-- dan nilai bawaan palsu akan membuat markup dihitung dengan aturan kota yang
-- salah tanpa ada yang tahu.

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "city" TEXT NOT NULL;
