FROM node:24.19.0-bookworm-slim AS build
WORKDIR /build
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm install --global pnpm@10.28.2
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY apps/customer-web/package.json ./apps/customer-web/package.json
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    pnpm install --frozen-lockfile
COPY apps/customer-web ./apps/customer-web
COPY packages ./packages
COPY scripts/prune-web-runtime.mjs ./scripts/prune-web-runtime.mjs
ENV NEXT_TELEMETRY_DISABLED=1 API_ORIGIN=http://api:3001 COOKIE_SECURE=true
RUN mkdir -p apps/customer-web/public && pnpm --filter @north/customer-web build && node scripts/prune-web-runtime.mjs
FROM node:24.19.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 COOKIE_SECURE=true
COPY --from=build --chown=node:node /build/apps/customer-web/.next/standalone ./
COPY --from=build --chown=node:node /build/apps/customer-web/.next/static ./apps/customer-web/.next/static
COPY --from=build --chown=node:node /build/apps/customer-web/public ./apps/customer-web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/customer-web/server.js"]
