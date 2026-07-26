FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends curl \
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

RUN pnpm install --frozen-lockfile --filter @app/test-web...

COPY apps/test-web apps/test-web

RUN pnpm --filter @app/test-web build

ENV NODE_ENV=production
EXPOSE 3001

HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=6 \
  CMD curl -fsS http://127.0.0.1:3001/health || exit 1

CMD ["node", "apps/test-web/dist/index.js"]
