# syntax=docker/dockerfile:1
#   docker build --build-arg APP_VERSION=$(git rev-parse HEAD) -t llm-gateway .
#   docker run --rm -p 4000:3000 -p 9464:9464 --env-file .env -e PORT=3000 llm-gateway
# APP_VERSION is the only build arg: one image runs on stage and prod, the rest
# is runtime env. Migrations run from the same image before a rollout:
# node dist/db/migrate.js (Argo CD Sync-hook Job, wave 0, before the Deployment).

# base: the Node image every stage starts from. Renovate updates the tag.
FROM node:26.13.0-trixie-slim AS base
WORKDIR /app

# deps: pnpm and the manifests.
FROM base AS deps
ENV CI=1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Node 25+ ships without corepack: install the pnpm that package.json "packageManager" names.
RUN npm install --global "$(node -p 'require("./package.json").packageManager')" \
    && npm cache clean --force

# build: dist/ from src/.
FROM deps AS build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# prod-deps: node_modules without dev dependencies.
FROM deps AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --store-dir /pnpm/store

# clis: the provider CLIs at pinned versions (a new version can change the
# output the gateway parses: update deliberately, with a live call). ripgrep
# for Claude Code. Both report their version at build time.
FROM base AS clis
RUN apt-get update -qq \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ca-certificates ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global @openai/codex@0.165.0 @anthropic-ai/claude-code@2.1.308 \
    && npm cache clean --force \
    && codex --version && claude --version

# runtime: files stay owned by root, so the app cannot change itself. The
# numeric non-root user (Kubernetes can verify runAsNonRoot) writes only to
# /tmp (emptyDir) and to CODEX_HOME (the login volume, D-105); the root
# filesystem is read-only. The CLIs keep their state under HOME=/tmp.
FROM clis AS runtime
ARG APP_VERSION=dev
LABEL org.opencontainers.image.title="llm-gateway" \
      org.opencontainers.image.version="${APP_VERSION}"
ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION} \
    PORT=3000 \
    METRICS_PORT=9464 \
    HOME=/tmp \
    CODEX_HOME=/codex-home \
    CLAUDE_CONFIG_DIR=/tmp/claude \
    USE_BUILTIN_RIPGREP=0 \
    DISABLE_UPDATES=1 \
    DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
COPY package.json ./
COPY drizzle ./drizzle
COPY config ./config
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER 10001:10001
EXPOSE 3000 9464
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
