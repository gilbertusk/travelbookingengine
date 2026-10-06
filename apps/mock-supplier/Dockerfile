# mock-supplier sebagai kontainer (Step 20).
#
# Dibangun dengan konteks AKAR REPO, bukan folder ini — mock-supplier
# bergantung pada @tbe/shared-kernel lewat workspace pnpm, dan lockfile-nya
# hanya ada di akar:
#
#   docker build -f apps/mock-supplier/Dockerfile -t tbe-mock-supplier .
#
# Satu tahap saja, dijalankan dari dalam workspace. Alternatif yang ditolak:
# `pnpm deploy` ke folder terpisah lalu disalin ke citra ramping. Citranya
# lebih kecil, tetapi kontainer ini hanya hidup di uji integrasi dan demo
# lokal, dan setiap langkah pengemasan tambahan adalah tempat baru untuk
# perbedaan antara yang diuji dan yang dijalankan.

FROM node:24-alpine

RUN corepack enable
WORKDIR /repo

# Seluruh repo disalin (lihat .dockerignore di akar): pnpm dengan lockfile
# beku butuh manifest SEMUA proyek workspace, bukan hanya milik service ini.
COPY . .

RUN pnpm install --frozen-lockfile --filter @tbe/mock-supplier... \
  && pnpm --filter @tbe/mock-supplier... run build

WORKDIR /repo/apps/mock-supplier

ENV NODE_ENV=production \
    PORT=4000 \
    OTEL_ENABLED=false

EXPOSE 4000

# Pengguna non-root bawaan citra node.
USER node

CMD ["node", "dist/index.js"]
