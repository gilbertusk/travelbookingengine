-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('customer', 'operator');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "role" "user_role" NOT NULL DEFAULT 'customer';

