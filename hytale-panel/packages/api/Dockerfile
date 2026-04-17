# ============================================================
# Hytale Panel API — Multi-stage Docker Build (pnpm workspace)
# ============================================================
# Stage 1: Build shared + api TypeScript using pnpm
# Stage 2: Produce a self-contained production bundle via pnpm deploy
# Stage 3: Production runtime (minimal image)
# ============================================================

FROM node:20-alpine AS builder

RUN corepack enable && (corepack prepare pnpm@9.15.4 --activate || npm install -g pnpm@9.15.4)

WORKDIR /build

# Copy workspace root files needed for pnpm install
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./

# Copy shared package (dependency of api)
COPY packages/shared/package.json packages/shared/
COPY packages/shared/tsconfig.json packages/shared/
COPY packages/shared/src packages/shared/src

# Copy api package
COPY packages/api/package.json packages/api/
COPY packages/api/tsconfig.json packages/api/
COPY packages/api/src packages/api/src

# Install all workspace dependencies
RUN pnpm install --frozen-lockfile

# Build shared first, then api
RUN pnpm --filter @hytale-panel/shared build
RUN pnpm --filter @hytale-panel/api build
RUN pnpm --filter @hytale-panel/api --prod deploy /prod/api
RUN rm -rf /prod/api/node_modules/.pnpm/node_modules/@hytale-panel/api
RUN mkdir -p /prod/api/dist/db && cp -R /build/packages/api/src/db/migrations /prod/api/dist/db/migrations

# ─── Production Stage ───────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Copy the self-contained production bundle created by pnpm deploy.
COPY --from=builder /prod/api/ /app/

# Use the built-in non-root node user (UID/GID 1000 on node:20-alpine).
USER node

EXPOSE 4000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:4000/api/health || exit 1

CMD ["node", "dist/index.js"]
