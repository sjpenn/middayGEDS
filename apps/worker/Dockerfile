# Base image with Bun
FROM oven/bun:1.3.10 AS base

# Install turbo CLI globally
FROM base AS turbo-cli
RUN bun add -g turbo

# Builder stage - prune worker workspace
FROM turbo-cli AS builder
WORKDIR /app
COPY . .
# Ensure .git-commit-sha exists (may not be present outside CI)
RUN touch .git-commit-sha
RUN turbo prune @midday/worker --docker --out-dir=out/worker

# Installer stage - install deps and build
FROM base AS installer
WORKDIR /app

# Install build dependencies for native modules
RUN apt-get update && apt-get install -y \
    python3 \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Copy package.json files from worker pruned workspace
COPY --from=builder /app/out/worker/json/ .
COPY bunfig.toml .

# Install dependencies (before copying full source to maximize cache hits)
RUN rm -f bun.lock
RUN bun install

# Copy full source from worker pruned workspace
COPY --from=builder /app/out/worker/full/ .

# Build workbench
RUN cd packages/workbench && bun run build

# Runner stage - clean image
FROM oven/bun:1.3.10 AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# Copy workspace from installer
COPY --from=installer /app/node_modules ./node_modules
COPY --from=installer /app/apps/worker ./apps/worker
COPY --from=installer /app/packages ./packages
COPY --from=installer /app/package.json ./package.json

# Self-host build: synthesize /tmp/git-sha.txt from build-arg or "unknown".
# (Railway CI used to write /app/.git-commit-sha before `railway up`.)
ARG GIT_COMMIT_SHA=unknown
RUN echo "${GIT_COMMIT_SHA}" > /tmp/git-sha.txt
COPY --from=builder /app/scripts/docker-entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

WORKDIR /app/apps/worker

EXPOSE 8080

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["bun", "src/index.ts"]
