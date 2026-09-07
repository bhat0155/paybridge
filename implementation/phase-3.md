# Phase 3 — Containerize (local only — no registry yet)

Source: `phases.md` → Phase 3. Goal: every service runs as a real Docker container — multi-stage build, slim non-root runtime — with no cloud registry involved yet (there isn't one until Phase 5). By the end, the exact same end-to-end result from Phase 2 happens with `docker compose up` instead of three `npm run dev:*` terminals.

## Steps

### 1. Install Trivy

**Why:** Trivy scans a built image for known vulnerabilities in its OS packages and dependencies. It wasn't needed until now — Phase 0's tool list didn't include it because there was nothing to scan yet.
```
brew install trivy
```

### 2. `.dockerignore` — before writing any Dockerfile

**Why this comes first, not last:** without it, `COPY . .` in a Dockerfile would copy `node_modules/`, `dist/`, `.git/`, and critically **`.env`** — your real SQL password and Stripe secret — into the image's build context and potentially into a layer. Per `CLAUDE.md`'s "no secrets in code" guardrail, that's a real leak risk, not a style nitpick: even if a later layer deletes the file, it can still exist in an earlier image layer that's fully extractable.

```
# .dockerignore
node_modules
**/node_modules
dist
**/dist
.env
.git
*.log
```

### 3. The multi-stage Dockerfile pattern

**Why multi-stage:** a build stage needs the TypeScript compiler, `tsx`, `vitest`, and every workspace's dev dependencies — none of which have any business existing in the thing that actually runs. The build stage compiles everything; the runtime stage only takes what's needed to execute the compiled JavaScript.

**Why the build stage builds the whole monorepo, not just one service:** these are npm workspaces — `ingest-api` imports `@paybridge/shared`, which must be compiled first. Rather than hand-rolling a workspace-filtered build order (fragile, easy to get wrong), the build stage simply reuses the same `npm run build` root script already proven in Phase 1/2 to build everything in the correct order. The cost is a slightly slower image build (compiling services you're not shipping in this particular image); the benefit is correctness with zero new moving parts. Revisit only if build time becomes an actual problem later.

`services/ingest-api/Dockerfile` (the full, representative example):
```dockerfile
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
```
`node:20.17-slim` is pinned to a specific tag, not `latest`, per `CLAUDE.md`. `USER node` switches to a non-root user that already exists in the official Node image — nothing to create manually.

**Note on image size:** the runtime stage above keeps the full `node_modules` (including dev tools like `typescript`/`vitest`) rather than pruning to production-only dependencies. `phases.md`'s own definition of "slim" here is specifically "pinned `-slim` tag, non-root user" — it doesn't mandate a dependency prune. A workspace-aware `npm prune --omit=dev` is a reasonable follow-up optimization, but workspace pruning can behave unexpectedly and isn't worth the risk of a broken image for this phase's actual requirement. Worth verifying by hand later if image size becomes a real concern.

`services/processor/Dockerfile` — identical build stage, runtime stage differs (no `EXPOSE`, since it's a worker with no HTTP port):
```dockerfile
# ---- Build stage: identical to ingest-api's, above ----
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
```

`services/reconciliation-api/Dockerfile` — same pattern, port `3003`:
```dockerfile
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

FROM node:20.17-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/shared/package.json ./shared/package.json
COPY --from=build /app/services/reconciliation-api/dist ./services/reconciliation-api/dist
COPY --from=build /app/services/reconciliation-api/package.json ./services/reconciliation-api/package.json

USER node
EXPOSE 3003
CMD ["node", "services/reconciliation-api/dist/index.js"]
```

### 4. Extend `docker-compose.yml` with the three app services

**Why extend the existing file instead of a new one:** Phase 2 deliberately left the three services out of `docker-compose.yml` because their Dockerfiles didn't exist yet. Now that they do, adding them here is what actually proves "everything runs containerized, together" — and it reuses the same Redis/SQL containers rather than standing up a second, parallel set.

**Why `SQL_HOST`/`REDIS_URL` need different values here than in `.env`:** inside a container, `localhost` means *that container itself*, not your laptop and not a sibling container. Docker Compose gives every service a DNS name equal to its service name (`sql`, `redis`) on the shared network it creates automatically — so the app containers need to talk to `sql`/`redis`, not `localhost`. `environment:` values in Compose override anything from `env_file` for the same key, so `.env` still supplies the secrets (`SQL_SA_PASSWORD`, `STRIPE_WEBHOOK_SECRET`), while the two hostnames get overridden per-service.

**Why `restart: on-failure`:** SQL Server takes several seconds after its container reports "started" before it's actually ready to accept logins (we saw this directly in Phase 2 verification). `processor` calls `ensureSchema()` immediately on startup — if it loses that race, it'll fail to connect. `depends_on` only controls *start order*, not "wait until ready," so `restart: on-failure` is the pragmatic local fix: if `processor` crashes because SQL wasn't ready yet, Compose just restarts it a moment later, by which point SQL is up. (Worth confirming this is actually sufficient once we run it for real — if it flaps, a proper healthcheck-based `depends_on: condition: service_healthy` would be the next step.)

```yaml
services:
  redis:
    image: redis:7.4-alpine
    ports:
      - "6379:6379"

  sql:
    image: mcr.microsoft.com/azure-sql-edge:1.0.7
    environment:
      ACCEPT_EULA: "Y"
      MSSQL_SA_PASSWORD: "${SQL_SA_PASSWORD}"
    ports:
      - "1433:1433"
    volumes:
      - paybridge-sql-data:/var/opt/mssql
    healthcheck:
      # azure-sql-edge ships no sqlcmd (confirmed in Phase 2) — a raw TCP check
      # via bash's /dev/tcp is the lightest thing that actually proves the port
      # is accepting connections, not just that the container process started.
      test: ["CMD-SHELL", "bash -c 'exec 3<>/dev/tcp/127.0.0.1/1433'"]
      interval: 5s
      timeout: 3s
      retries: 10
      start_period: 5s

  ingest-api:
    build:
      context: .
      dockerfile: services/ingest-api/Dockerfile
    image: paybridge-ingest-api:local
    env_file: .env
    environment:
      REDIS_URL: redis://redis:6379
    ports:
      - "3001:3001"
    depends_on:
      - redis
    restart: on-failure

  processor:
    build:
      context: .
      dockerfile: services/processor/Dockerfile
    image: paybridge-processor:local
    env_file: .env
    environment:
      SQL_HOST: sql
      REDIS_URL: redis://redis:6379
    depends_on:
      redis:
        condition: service_started
      sql:
        condition: service_healthy
    restart: on-failure

  reconciliation-api:
    build:
      context: .
      dockerfile: services/reconciliation-api/Dockerfile
    image: paybridge-reconciliation-api:local
    env_file: .env
    environment:
      SQL_HOST: sql
    ports:
      - "3003:3003"
    depends_on:
      sql:
        condition: service_healthy
    restart: on-failure

volumes:
  paybridge-sql-data:
```
`image:` names are set explicitly (`paybridge-ingest-api:local`, etc.) rather than relying on Compose's automatic naming, so the Trivy scan commands in Step 6 are unambiguous. `ingest-api` doesn't depend on `sql` at all — it never touches the database, only Redis.

**Update from live testing (2026-09-06):** the first version of this file used plain `depends_on: [redis, sql]`, relying only on `restart: on-failure` to paper over SQL not being ready yet. Running it for real, `processor` crash-looped 5 times against `ECONNREFUSED` before SQL finished starting, then self-healed. It technically satisfied this phase's Definition of Done (it did eventually work), but it was needlessly noisy — so it was upgraded to the healthcheck-based `depends_on` shown above. Confirmed live: `docker compose up` now shows `sql-1 Waiting` → `sql-1 Healthy`, then `processor`/`reconciliation-api` start, and `processor` logs `processor started` on the very first attempt with zero restarts.

### 5. Build all three images

```
docker compose build
```
**What this proves:** the multi-stage Dockerfiles are syntactically correct and the monorepo build actually completes inside a container — not just on your host machine, which can hide "works on my machine" issues (different Node version, a file only `.gitignore`d locally, etc.).

### 6. Run Trivy against each image

```
trivy image paybridge-ingest-api:local
trivy image paybridge-processor:local
trivy image paybridge-reconciliation-api:local
```
**Why per-image, not once:** each image is built from the same base but ends up with different final contents (different service's `dist`), so scanning each independently is the correct unit — a vulnerability fixed in one doesn't imply anything about the others.
**Definition of Done language is "pass (or have triaged)"** — meaning: if Trivy reports something, the goal isn't necessarily zero findings, it's understanding what's found and making a deliberate call (upgrade, accept, or note as a known issue) rather than ignoring the report entirely.

**Triage log (run live, 2026-09-06):** `trivy image --severity HIGH,CRITICAL` reported 119 findings — identical across all three images:
- **72 findings** from Debian OS packages in the `node:20.17-slim` base itself (e.g. `libgnutls30`, `perl-base`, `util-linux`) — unpatched-upstream CVEs common to any Debian-based image, not caused by anything in this Dockerfile.
- **22 + 25 = 47 findings** from `vite`/`vitest`/`esbuild` — devDependencies that only `ingest-api` declares (for its unit tests), yet present in **all three** images. Cause: npm workspaces hoist every workspace's dependencies into one shared root `node_modules`, and the runtime stage copies that entire folder (`COPY --from=build /app/node_modules ./node_modules`) into every service's image regardless of what that specific service actually needs.
- **Decision: accepted, not fixed, in Phase 3.** A workspace-aware `npm prune --omit=dev` in the runtime stage would eliminate the 47 devDependency-driven findings, but requires copying the root `package.json`/`package-lock.json` plus all workspace manifests into the runtime stage too (not just the two currently copied), which reopens complexity deliberately deferred in Step 3. Logged here as a known, understood finding per the "or have triaged" language in the Definition of Done below — a good candidate to revisit if/when this matters more (e.g. before a real deployment).

### 7. Bring the whole stack up

```
npm run db:down          # stop the Phase 2 host-only redis/sql, avoid port clashes
docker compose up -d
```
**What this proves:** this is the actual Phase 3 finish line — every service, including the three that used to run via `npm run dev:*`, now runs as a container, wired together entirely through Docker's own networking, no `localhost` involved between services.

## Hands-on scenarios — replicate these yourself

Same scenarios as `implementation/phase-2.md`, run again against containers instead of `npm run dev:*` — if Phase 2 worked and these still pass, that's proof containerizing didn't change any actual behavior, only how the services run.

### Scenario 1 — Watch the containers start and the schema get created

```
docker compose up -d
docker compose logs -f processor
```
**What you should see:** eventually `processor started` in the log stream (possibly after one restart, if it lost the race with SQL — see Step 4's note). `docker compose ps` shows all five containers `Up`.
**What this proves:** the runtime image has everything it needs (no missing files from an incomplete `COPY`) and can actually reach `sql` and `redis` by their Compose service names.

### Scenario 2 — A fake QuickBooks payment, against the container

```
curl -s -X POST http://localhost:3001/webhooks/quickbooks \
  -H "Content-Type: application/json" \
  -d '{"invoice_id":"INV-2001","customer":"Jane Doe","amount_due":12.50,"currency":"USD","memo":"Coffee","status":"paid","issued_date":"2026-09-06"}'
curl -s http://localhost:3003/transactions?source=qb
```
**What this proves:** the published port mapping (`3001:3001`, `3003:3003`) works exactly like the host process did — from outside Docker, there's no observable difference.

### Scenario 3 — Idempotency, still enforced

Re-send the exact same curl from Scenario 2. Check `docker compose logs processor` for `duplicate event INV-2001 — already processed, skipping`, and confirm the row count via `reconciliation-api` didn't change.
**What this proves:** the `UNIQUE(source, source_event_id)` constraint and the dedupe logic work identically inside a container — this was never host-specific behavior.

### Scenario 4 — Real Stripe webhook, still against the container

```
stripe listen --forward-to localhost:3001/webhooks/stripe
stripe trigger charge.succeeded
```
**What this proves:** `stripe listen` doesn't know or care that `localhost:3001` is now a Docker container instead of a host process — it's still just an HTTP port on your machine.

### Scenario 5 — Data survives a container rebuild

```
docker compose up -d --build ingest-api
curl -s http://localhost:3003/transactions
```
**What you should see:** rebuilding and recreating the `ingest-api` container doesn't touch the `payments` table — all earlier rows are still there.
**What this proves:** the SQL volume from Phase 2 is independent of any particular container's lifecycle — exactly the separation you want between "my application code" and "my data."

## Definition of Done (from `phases.md`)

> All three images build clean and pass (or have triaged) the Trivy scan, running locally via `docker run` reproduces Phase 2's end-to-end result.

Cross-checked: Step 5 (`docker compose build`) satisfies "build clean." Step 6 (Trivy against each of the three images) satisfies "pass or have triaged." Steps 7 plus the Hands-on Scenarios (QuickBooks payment, idempotency, real Stripe webhook, all producing identical results to Phase 2) satisfy "reproduces Phase 2's end-to-end result" — using `docker compose up`, which is Docker Compose orchestrating `docker run` under the hood for multiple linked containers, a faithful reading of the phase given three services need to run together, not in isolation. Scope deliberately excludes: any container registry or push (that's Phase 5 — `docker compose build` only builds locally), and any cloud resource whatsoever.
