# Browser worker image: Chromium (via Playwright), Xvfb, x11vnc and websockify.
# The Playwright base image already ships Chromium and all its OS dependencies,
# so only the display and VNC tooling has to be added.
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb \
      x11vnc \
      websockify \
      python3-numpy \
      openssl \
      ca-certificates \
      curl \
      gnupg \
      procps \
    && rm -rf /var/lib/apt/lists/*

# This base image ships Node 20, but pnpm 11 requires Node >= 22.13.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && node --version

# The corepack bundled with this base image cannot verify current npm signing
# keys, so pnpm is installed directly.
RUN npm install -g pnpm@11.17.0

WORKDIR /app

# Workspace manifests first, so dependency installation is cached separately
# from the application sources.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/database/package.json packages/database/
COPY packages/workflow-schema/package.json packages/workflow-schema/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY apps/test-web/package.json apps/test-web/

RUN pnpm install --frozen-lockfile --filter @app/worker... --filter @app/database...

COPY packages packages
COPY apps/worker apps/worker

RUN pnpm --filter @app/shared build \
    && pnpm --filter @app/workflow-schema build \
    && pnpm --filter @app/database build \
    && pnpm --filter @app/worker build

# Artifacts (error screenshots, downloads) and upload fixtures live on volumes
# shared with the API.
RUN mkdir -p /data/artifacts /data/uploads && chmod -R 777 /data
# Files an upload step is allowed to send. Nothing outside this directory can be
# uploaded by a workflow.
COPY docker/browser/fixtures/ /opt/upload-fixtures/

ENV NODE_ENV=production
EXPOSE 5000

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
  CMD curl -fsS http://127.0.0.1:5000/health || exit 1

CMD ["node", "apps/worker/dist/index.js"]
