# The LEGACY backend, containerised unmodified so staging runs the real pair
# (gateway in front, legacy behind). Built from the monorepo root:
#   docker build -f backend/Dockerfile -t datahub-legacy .
#
# This image exists to be proxied to and retired domain-by-domain — not to be
# developed against. Source is copied as-is (ADR-0003: legacy stays untouched).

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/ui/package.json packages/ui/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY backend/package.json backend/
RUN pnpm install --frozen-lockfile --prod --filter ./backend

FROM base AS runner
ENV NODE_ENV=production
ENV PORT=4000

# The legacy PDF/OCR pipeline shells out to Python (backend/python/*).
RUN apk add --no-cache python3 py3-pip

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/backend/node_modules ./backend/node_modules
COPY backend ./backend

USER node
EXPOSE 4000
WORKDIR /app/backend
CMD ["node", "src/server.js"]
