# syntax=docker/dockerfile:1.7
#
# Chekku agent (Mastra server) production image.
#
# Build context MUST be the repository root so the workspace symlink for
# `@chekku/storage` resolves during `npm ci` and so `mastra build` can bundle
# the storage workspace. Build from the repo root:
#
#     docker build -f agent/Dockerfile -t chekku-agent .
#
# Mastra inlines `@chekku/storage` into the emitted bundle, but externalizes
# the runtime dependencies (`@mastra/*`, `@ai-sdk/*`, `@aws-sdk/client-s3`,
# `zod`, `hono`, etc.) as bare imports. The runtime stage therefore needs the
# production `node_modules`. The `storage/` workspace is copied too so the
# build-time and runtime layouts match regardless of how Mastra's bundler
# evolves. The runtime stage's final WORKDIR is `/app/agent` so the relative
# `CMD ["node", ".mastra/output/index.mjs"]` resolves against the built output.

# ===== Stage 1: builder =====
FROM node:22-bookworm-slim AS builder
# Do NOT set NODE_ENV=development here: `npm ci` installs devDependencies
# regardless of NODE_ENV, while `next build`/`mastra build` must run under
# the default production NODE_ENV (forcing development breaks prerendering).
WORKDIR /app
# Copy workspace manifests first for a cacheable `npm ci` layer.
COPY package.json package-lock.json ./
COPY agent/package.json agent/
COPY client/package.json client/
COPY storage/package.json storage/
RUN npm ci
# Copy agent and storage source. `@chekku/storage` exports raw TypeScript and
# has no build step, so its source must be present when Mastra bundles it.
COPY agent/ agent/
COPY storage/ storage/
# Emit the Mastra server bundle to agent/.mastra/output.
RUN npm run build --workspace agent

# ===== Stage 2: runtime =====
FROM node:22-bookworm-slim AS runtime
# Chromium and shared libraries for playwright-core (QA Web Agent).
# `playwright-core` does NOT download a browser, so it reuses system Chromium.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
      libgbm1 libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 \
      fonts-liberation ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Copy hoisted and workspace-local production dependencies plus the built
# Mastra output. The `storage/` workspace is currently inlined into the bundle
# by Mastra; it is copied anyway so the runtime layout matches the build layout
# even if a future Mastra version externalizes it via an absolute path.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/agent/node_modules ./agent/node_modules
COPY --from=builder /app/storage ./storage
COPY --from=builder /app/agent/.mastra ./agent/.mastra
COPY --from=builder /app/agent/package.json ./agent/package.json
COPY --from=builder /app/package.json ./package.json
# Pin playwright-core to the system Chromium, bind off loopback, and keep the
# Android QA integration off (Maestro stays host/device-only).
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
    BROWSER_HEADLESS=true \
    HOST=0.0.0.0 \
    NODE_ENV=production \
    MAESTRO_ENABLED=false
WORKDIR /app/agent
EXPOSE 4111
# Mastra exposes GET /healthz (returns 503 when storage is unavailable).
HEALTHCHECK --interval=5s --timeout=3s --retries=30 --start-period=15s \
  CMD node -e "const p=process.env.PORT||4111;fetch('http://127.0.0.1:'+p+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", ".mastra/output/index.mjs"]
