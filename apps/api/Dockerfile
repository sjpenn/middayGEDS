# Base image with Bun
FROM oven/bun:1.3.10 AS base

# Install turbo CLI globally
FROM base AS turbo-cli
RUN bun add -g turbo

# Builder stage - prune API workspace
FROM turbo-cli AS builder
WORKDIR /app
COPY . .
# Ensure .git-commit-sha exists (may not be present outside CI)
RUN touch .git-commit-sha
RUN turbo prune @midday/api --docker

# Installer stage - install deps and build
FROM base AS installer
WORKDIR /app

# Install dependencies
COPY --from=builder /app/out/json/ .
COPY bunfig.toml .
# Force devDependencies even when the platform injects NODE_ENV=production
# (bun omits devDeps under NODE_ENV=production, stripping the build toolchain).
RUN NODE_ENV=development bun install

# Copy full source
COPY --from=builder /app/out/full/ .

# Build the mcp-apps package (produces self-contained HTML files)
RUN cd packages/mcp-apps && bun run build

# Runner stage - clean image
FROM oven/bun:1.3.10 AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# Copy only what's needed at runtime
COPY --from=installer /app/node_modules ./node_modules
COPY --from=installer /app/apps/api ./apps/api
COPY --from=installer /app/packages ./packages
COPY --from=installer /app/package.json ./package.json

# Self-host build: synthesize /tmp/git-sha.txt from build-arg or "unknown".
# (Railway CI used to write /app/.git-commit-sha before `railway up`.)
ARG GIT_COMMIT_SHA=unknown
RUN echo "${GIT_COMMIT_SHA}" > /tmp/git-sha.txt
COPY --from=builder /app/scripts/docker-entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

WORKDIR /app/apps/api

EXPOSE 8080

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["bun", "src/index.ts"]
