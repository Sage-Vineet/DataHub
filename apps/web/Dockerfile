# The SPA, built and served statically. Built from the monorepo root:
#   docker build -f apps/web/Dockerfile --build-arg VITE_API_BASE_URL=... -t datahub-web .
#
# VITE_API_BASE_URL is a BUILD arg, not a runtime env var: Vite inlines it into
# the bundle at build time. Changing where the SPA points therefore means a
# rebuild, not a restart — the same constraint that applies on Vercel.

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
COPY tools/demo/package.json tools/demo/
RUN pnpm install --frozen-lockfile --filter @datahub/web...

FROM deps AS builder
ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
COPY packages/config packages/config
COPY packages/ui packages/ui
COPY apps/web apps/web
RUN pnpm --filter @datahub/web... build

FROM nginx:alpine AS runner
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
# The app uses HashRouter, so deep links never reach the server as paths — but a
# catch-all keeps it correct if it ever moves to BrowserRouter.
RUN printf 'server {\n\
  listen 5173;\n\
  root /usr/share/nginx/html;\n\
  index index.html;\n\
  location / { try_files $uri $uri/ /index.html; }\n\
}\n' > /etc/nginx/conf.d/default.conf
EXPOSE 5173
