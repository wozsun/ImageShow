FROM node:26.5.0 AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/web/package.json packages/web/package.json
COPY packages/docs/package.json packages/docs/package.json
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY . .
RUN npm run check && npm run build

FROM node:26.5.0 AS prod-deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/server/package.json packages/server/package.json
RUN npm ci --omit=dev --workspace @imageshow/shared --workspace @imageshow/server --include-workspace-root=false

FROM node:26.5.0-slim AS runtime
WORKDIR /app
ARG PORT=5518
ENV NODE_ENV=production \
    PORT=${PORT} \
    MALLOC_ARENA_MAX=2
RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/*
COPY --chown=node:node --from=build /app/package.json /app/package-lock.json* ./
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --chown=node:node --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --chown=node:node --from=build /app/packages/server/package.json ./packages/server/package.json
COPY --chown=node:node --from=build /app/packages/server/dist ./packages/server/dist
RUN mkdir -p /app/data/storage /app/data/log && chown -R node:node /app/data
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY scripts/runtime/imageshow /usr/local/bin/imageshow
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh /usr/local/bin/imageshow \
    && chmod +x /usr/local/bin/docker-entrypoint.sh /usr/local/bin/imageshow
EXPOSE ${PORT}
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --start-interval=3s --retries=3 CMD node packages/server/dist/healthcheck-cli.js
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "packages/server/dist/index.js"]
