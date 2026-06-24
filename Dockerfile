FROM node:24 AS deps
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

FROM node:24 AS prod-deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/server/package.json packages/server/package.json
RUN npm ci --omit=dev --workspace @imageshow/shared --workspace @imageshow/server --include-workspace-root=false

FROM node:24-slim AS runtime
WORKDIR /app
ARG PORT=5518
ENV NODE_ENV=production \
    PORT=${PORT}
COPY --chown=node:node --from=build /app/package.json /app/package-lock.json* ./
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --chown=node:node --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --chown=node:node --from=build /app/packages/server/package.json ./packages/server/package.json
COPY --chown=node:node --from=build /app/packages/server/dist ./packages/server/dist
RUN mkdir -p /app/data/storage /app/data/log && chown -R node:node /app/data
USER node
EXPOSE ${PORT}
HEALTHCHECK --interval=30s --timeout=10s --retries=3 CMD node packages/server/dist/healthcheck-cli.js
CMD ["node", "packages/server/dist/index.js"]
