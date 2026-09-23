#!/bin/bash
# Membuat satu database terpisah untuk tiap service.
#
# Database per service adalah keputusan arsitektur, bukan preferensi: tanpa
# pemisahan ini, join lintas service menjadi mungkin, dan begitu satu join
# ditulis, batas kepemilikan data hilang dan microservices-nya tinggal nama.
#
# Dijalankan sekali oleh entrypoint Postgres saat volume masih kosong.
# Untuk menjalankan ulang: pnpm infra:reset

set -euo pipefail

if [ -z "${SERVICE_DATABASES:-}" ]; then
  echo "init-db: SERVICE_DATABASES tidak diset, tidak ada database yang dibuat" >&2
  exit 1
fi

echo "init-db: membuat database per service"

IFS=',' read -ra DATABASES <<<"$SERVICE_DATABASES"

for db in "${DATABASES[@]}"; do
  db="$(echo "$db" | tr -d '[:space:]')"
  [ -z "$db" ] && continue

  echo "init-db:   -> $db"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-EOSQL
		CREATE DATABASE "$db";
		GRANT ALL PRIVILEGES ON DATABASE "$db" TO "$POSTGRES_USER";
	EOSQL
done

echo "init-db: selesai, ${#DATABASES[@]} database dibuat"
