-- Step 26: daftar pemesanan pengguna, menurut pemiliknya dan tanggal masuk.

-- CreateIndex
CREATE INDEX "bookings_user_id_check_in_idx" ON "bookings"("user_id", "check_in");
