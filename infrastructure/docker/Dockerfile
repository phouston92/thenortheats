FROM node:24.19.0-bookworm-slim
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm install --global pnpm@10.28.2
WORKDIR /app
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node apps ./apps
COPY --chown=node:node packages ./packages
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node tsconfig.json ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    pnpm install --frozen-lockfile
ARG WORKSPACE=@north/customer-web
RUN pnpm --filter ${WORKSPACE} --if-present build
USER node
# Development image. Do not copy local .env files or activate production.
CMD ["pnpm", "dev:api"]
