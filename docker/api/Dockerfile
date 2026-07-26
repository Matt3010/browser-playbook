FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
# Prisma needs openssl; curl is used by the healthcheck.
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@11.17.0 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/database/package.json packages/database/
COPY packages/workflow-schema/package.json packages/workflow-schema/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY apps/test-web/package.json apps/test-web/

RUN pnpm install --frozen-lockfile --filter @app/api... --filter @app/database...

COPY packages packages
COPY apps/api apps/api

RUN pnpm --filter @app/shared build \
    && pnpm --filter @app/workflow-schema build \
    && pnpm --filter @app/database build \
    && pnpm --filter @app/api build

RUN mkdir -p /data/artifacts /data/uploads && chmod -R 777 /data

ENV NODE_ENV=production
EXPOSE 4000

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=6 \
  CMD curl -fsS http://127.0.0.1:4000/health || exit 1

CMD ["node", "apps/api/dist/index.js"]
