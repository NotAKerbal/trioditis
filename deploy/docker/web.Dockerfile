# Caddy, serving the web app and proxying to the Convex backend. The web app is
# apps/desktop's static build (a Vite SPA) when it exists; until then, a placeholder that
# says the server is up and lets the admin finish setup.
FROM node:24.21-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS web

RUN corepack enable
WORKDIR /repo
COPY . .
# The real client plugs in here: once the branch has apps/desktop, its static build is used.
# It bakes in no URLs: it reads /config.json at startup, which install.sh writes and Caddy
# serves (see Caddyfile), so one image works for any address.
RUN if [ -f apps/desktop/package.json ]; then \
      pnpm install --frozen-lockfile --filter @trioditis/desktop... \
      && pnpm --filter @trioditis/desktop build \
      && cp -r apps/desktop/dist /web; \
    else \
      cp -r deploy/web/placeholder /web; \
    fi

FROM caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d
COPY deploy/compose/Caddyfile /etc/caddy/Caddyfile
COPY --from=web /web /srv/web
