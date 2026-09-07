# ---- Build stage ----
FROM node:20.17-slim AS build
WORKDIR /app

# Manifests first, for Docker layer caching — this layer only invalidates
# when a package.json or the lockfile changes, not on every source edit.
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/package.json
COPY services/ingest-api/package.json services/ingest-api/package.json
COPY services/processor/package.json services/processor/package.json
COPY services/reconciliation-api/package.json services/reconciliation-api/package.json
RUN npm ci

# Now the real source, and build everything (shared, then all 3 services).
COPY shared shared
COPY services services
RUN npm run build

# ---- Runtime stage ----
FROM node:20.17-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/shared/package.json ./shared/package.json
COPY --from=build /app/services/ingest-api/dist ./services/ingest-api/dist
COPY --from=build /app/services/ingest-api/package.json ./services/ingest-api/package.json

USER node
EXPOSE 3001
CMD ["node", "services/ingest-api/dist/index.js"]
