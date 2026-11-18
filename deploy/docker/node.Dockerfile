# The Node side of the server: the gateway, and the one-shot job that deploys the Convex
# functions. One image for both, so an install builds it once.
FROM node:24.21-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

RUN corepack enable
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY packages packages
COPY apps/gateway apps/gateway
COPY deploy/scripts deploy/scripts

# Only what the gateway and the functions deploy need, exactly as locked.
RUN pnpm install --frozen-lockfile --filter @trioditis/gateway... --filter @trioditis/backend... \
  && chown -R node:node /repo

USER node
ENV NODE_ENV=production
CMD ["node", "apps/gateway/src/main.ts"]
