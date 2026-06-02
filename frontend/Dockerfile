# Two-stage: Vite build, then nginx serves the static bundle and
# reverse-proxies /api/* to the backend container. This is the prod
# replacement for `pnpm dev` + the dev server's /api proxy.

ARG NODE_VERSION=22

# ---------- builder ----------
FROM node:${NODE_VERSION}-alpine AS builder

# pnpm via corepack — no global install, no version drift.
RUN corepack enable

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY . .
# `tsc` runs as part of build via package.json scripts; if you bump
# something and want to skip type-check, use `pnpm vite build` instead.
RUN pnpm build

# ---------- runtime ----------
FROM nginx:1.27-alpine AS runtime

# Override nginx's default site config with one that serves the SPA
# (history-fallback to /index.html) and proxies /api/ to the backend.
COPY nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

# nginx default CMD is fine.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz || exit 1
