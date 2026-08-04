# syntax=docker/dockerfile:1.7
#
# Chekku client (Next.js studio) production image.
#
# Build context MUST be the repository root so the `@chekku/storage` workspace
# symlink resolves during `npm ci` and so Next.js standalone file tracing can
# follow `storage/` out of `client/`. Build from the repo root:
#
#     docker build -f client/Dockerfile -t chekku-client .
#
# `client/next.config.ts` MUST set `output: 'standalone'`,
# `outputFileTracingRoot: <repo root>`, and `transpilePackages: ['@chekku/storage']`
# for this image to work.

# ===== Stage 1: builder =====
FROM node:22-bookworm-slim AS builder
# Do NOT set NODE_ENV=development here: `npm ci` installs devDependencies
# regardless of NODE_ENV, while `next build` must run under the default
# production NODE_ENV (forcing development trips the non-standard-NODE_ENV
# warning and breaks `/_global-error` prerendering).
WORKDIR /app
# Copy workspace manifests first for a cacheable `npm ci` layer. All three
# workspace package.json files are needed so npm can resolve the workspaces.
COPY package.json package-lock.json ./
COPY agent/package.json agent/
COPY client/package.json client/
COPY storage/package.json storage/
RUN npm ci
# Copy client and storage source. The Next.js proxy server imports
# `@chekku/storage` (raw TypeScript), so storage source must be present for
# `transpilePackages` and standalone file tracing.
COPY client/ client/
COPY storage/ storage/
# NEXT_PUBLIC_* are inlined by `next build`, not read at runtime. Pass the
# public origin in as a build arg so the browser bundle (mastra-client.ts)
# targets the right URL instead of baking in the localhost fallback.
ARG NEXT_PUBLIC_APP_URL=http://localhost:3000
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
RUN npm run build --workspace client

# ===== Stage 2: runtime =====
FROM node:22-bookworm-slim AS runtime
# tini for proper PID 1 signal handling (ENTRYPOINT below expects /usr/bin/tini).
# ca-certificates is included for any outbound HTTPS the Next.js server performs.
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
# Next.js standalone output contains the traced node_modules and server.js.
# Static assets are emitted separately and must be copied beside it.
COPY --from=builder /app/client/.next/standalone ./
COPY --from=builder /app/client/.next/static ./client/.next/static
# Next 16 binds 0.0.0.0 by default; keep WORKDIR on the client workspace so
# server.js resolves its relative chunks correctly.
WORKDIR /app/client
EXPOSE 3000
# Next.js has no dedicated health route; the home page is server-rendered.
# Any 5xx response (or connection failure) marks the container unhealthy.
HEALTHCHECK --interval=5s --timeout=3s --retries=30 --start-period=8s \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
