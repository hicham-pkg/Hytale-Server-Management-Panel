FROM node:20-alpine AS builder

RUN corepack enable && (corepack prepare pnpm@9.15.4 --activate || npm install -g pnpm@9.15.4)

WORKDIR /build

# Copy workspace root files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./

# Copy shared package (needed for workspace resolution)
COPY packages/shared/package.json packages/shared/
COPY packages/shared/ packages/shared/

# Copy web package
COPY packages/web/package.json packages/web/
COPY packages/web/ packages/web/

# Install dependencies and build
RUN pnpm install --frozen-lockfile
RUN pnpm run build:shared
RUN pnpm --filter @hytale-panel/web build
RUN mkdir -p /build/packages/web/public

FROM node:20-alpine

WORKDIR /app

COPY --from=builder /build/packages/web/.next/standalone ./
COPY --from=builder /build/packages/web/.next/static ./packages/web/.next/static
COPY --from=builder /build/packages/web/public ./packages/web/public

USER node
EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "packages/web/server.js"]
