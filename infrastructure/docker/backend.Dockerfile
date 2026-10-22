# Build-only toolchain. No workspace node_modules is copied to the runtime.
FROM node:24.19.0-bookworm-slim AS build
WORKDIR /build
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm install --global pnpm@10.28.2
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY apps/api/package.json ./apps/api/package.json
# No mobile/frontend workspace is present during dependency installation.
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    pnpm install --frozen-lockfile
COPY apps/api ./apps/api
COPY apps/worker/src ./apps/worker/src
COPY packages ./packages
COPY scripts/build-backend.mjs ./scripts/build-backend.mjs
RUN pnpm build:backend && pnpm --filter @north/api deploy --prod /runtime

FROM node:24.19.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3001
COPY --from=build --chown=node:node /runtime/node_modules ./node_modules
COPY --from=build --chown=node:node /build/dist/backend/api.mjs /build/dist/backend/worker.mjs ./
COPY --chown=node:node scripts/runtime-env.mjs ./runtime-env.mjs
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "runtime-env.mjs"]
CMD ["api"]

# Separate one-off schema-owner job; never grant its credential to API/worker.
FROM runtime AS migration
COPY --from=build --chown=node:node /build/dist/backend/migrate.mjs ./bin/migrate.mjs
COPY --from=build --chown=node:node /build/packages/database/migrations ./migrations
COPY --chown=node:node scripts/migration-env.mjs ./migration-env.mjs
ENTRYPOINT ["node", "migration-env.mjs"]
CMD []

# Default target is the application runtime, excluding migration tooling/SQL.
FROM runtime AS release
