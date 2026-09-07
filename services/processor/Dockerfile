# ---- Build stage ----
FROM node:20.17-slim AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/package.json
COPY services/ingest-api/package.json services/ingest-api/package.json
COPY services/processor/package.json services/processor/package.json
COPY services/reconciliation-api/package.json services/reconciliation-api/package.json
RUN npm ci

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
COPY --from=build /app/services/processor/dist ./services/processor/dist
COPY --from=build /app/services/processor/package.json ./services/processor/package.json

USER node
CMD ["node", "services/processor/dist/index.js"]
