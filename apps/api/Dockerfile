# The gateway (apps/api). Built from the monorepo root:
#   docker build -f apps/api/Dockerfile -t datahub-gateway .
#
# It was the cutover seam: with every *_MODULE_ENABLED flag unset the image was
# a transparent reverse proxy to LEGACY_ORIGIN, deployable ahead of any domain
# moving (ADR-0003). The migration is finished, so it serves every route itself
# and there is no upstream to proxy to.

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

# ── deps ──────────────────────────────────────────────────────────────────────
# Manifests only, so the install layer caches until a dependency actually changes.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/financial-engine/package.json packages/financial-engine/
COPY packages/ui/package.json packages/ui/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @datahub/api...

# ── build ─────────────────────────────────────────────────────────────────────
FROM deps AS builder
COPY packages/config packages/config
COPY packages/contracts packages/contracts
COPY packages/db packages/db
COPY packages/financial-engine packages/financial-engine
COPY apps/api apps/api
RUN pnpm --filter @datahub/api... build

# ── production deps ───────────────────────────────────────────────────────────
# A separate install so devDependencies (tsx, vitest, typescript) never ship.
FROM deps AS prod-deps
RUN pnpm install --frozen-lockfile --prod --filter @datahub/api...

# ── runtime ───────────────────────────────────────────────────────────────────
FROM base AS runner
ENV NODE_ENV=production
# The gateway listens here; compose/hosting may override.
ENV PORT=8080

# Copy production node_modules (root + each workspace package) and the compiled
# output. @datahub/contracts and @datahub/db resolve their `default` export
# condition to dist/ at runtime — hence the build above is required.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=prod-deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=prod-deps /app/packages/financial-engine/node_modules ./packages/financial-engine/node_modules
COPY --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules

COPY --from=builder /app/packages/contracts/package.json ./packages/contracts/
COPY --from=builder /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=builder /app/packages/db/package.json ./packages/db/
COPY --from=builder /app/packages/db/dist ./packages/db/dist
COPY --from=builder /app/packages/financial-engine/package.json ./packages/financial-engine/
COPY --from=builder /app/packages/financial-engine/dist ./packages/financial-engine/dist
COPY --from=builder /app/apps/api/package.json ./apps/api/
COPY --from=builder /app/apps/api/dist ./apps/api/dist

# Drop privileges — the node image ships an unprivileged `node` user.
USER node

EXPOSE 8080
# Liveness uses the gateway's own /healthz, which never proxies, so the check
# reports the gateway's own health.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/apps/api
CMD ["node", "dist/server.js"]
