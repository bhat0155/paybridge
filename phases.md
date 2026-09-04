# phases.md — PayBridge Build Chronology (the "how")

Companion to `CLAUDE.md` (what/why) and `contracts.md` (data contracts). This file is the "how" — concrete tools, steps, and infrastructure, in dependency order.

**Rule:** each phase may only use things that already exist because an earlier phase created them. If a step needs a resource, a permission, a credential, or an artifact that doesn't exist yet, that step is in the wrong phase.

**Two identities, not one** (referenced from Phase 4 onward — called out once here to avoid confusion later):
- **Deploy identity** — the Azure AD app registration + federated credential GitHub Actions uses via OIDC to run `az`/Terraform commands. Created once, manually, in Phase 4. Scoped to Contributor on the resource group only.
- **Runtime identity** — the user-assigned managed identity attached to the actual running app (Container Apps, later AKS workloads). Created in Phase 5. Scoped narrowly: Key Vault Secrets User, AcrPull, Service Bus Sender/Receiver. This is what the application code authenticates as via `DefaultAzureCredential` — it has nothing to do with deploying infrastructure.

---

## Phase 0 — Prerequisites & tooling

Nothing below works without this. No cloud, no code yet.

- Install: Node.js + npm, Docker, Azure CLI, Terraform CLI, Stripe CLI, git.
- `az login` to an Azure subscription with rights to create resources (needed later, confirmed here).
- **Done when:** `node -v`, `docker ps`, `az account show`, `terraform version`, `stripe --version` all succeed.

## Phase 1 — Local application foundation

- Scaffold the monorepo: `services/ingest-api`, `services/processor`, `services/reconciliation-api`, `shared/` — Node.js + TypeScript, Express for the two APIs.
- `shared/` holds the common schema (the table from `contracts.md`) as TypeScript types/Zod schemas, imported by all three services.
- Define a `queue` interface in `shared/` (publish/consume) with no implementation yet — this is what lets local and cloud swap transport without touching business logic.
- Define an `email` interface in `shared/` (send-confirmation) with no implementation yet, per the "keep the email provider swappable" guardrail.
- **Done when:** all three services compile and start, importing shared types, with stub (no-op) implementations of `queue` and `email`.

## Phase 2 — Local integration

- Implement the local `queue`: in-memory or Redis-backed, satisfying the Phase 1 interface.
- Implement the local `email`: console/log output, satisfying the Phase 1 interface.
- `docker-compose.yml`: the 3 services + a SQL Server container (Azure SQL Edge image, since real Azure SQL isn't local) + Redis if used for the queue.
- Add a schema init script/migration that creates the common-schema table in the local SQL container on startup — an empty container has no tables yet.
- Local secrets/config via a gitignored `.env` (this is fine for local only — cloud never does this; that's Phase 7).
- Stripe CLI (`stripe listen --forward-to localhost:.../webhooks/stripe`) for real signed webhooks against `ingest-api`.
- QuickBooks mock: a timer loop that POSTs a mock invoice JSON to `ingest-api` on an interval.
- **Done when:** a fake payment (from Stripe test mode or the QB mock) flows: ingested → normalized → published to the local queue → consumed by the processor → row written to local SQL → confirmation logged → visible via `GET /transactions` on the reconciliation API.

## Phase 3 — Containerize (local only — no registry yet)

- One multi-stage `Dockerfile` per service: build stage (`npm ci && npm run build`) → slim runtime stage (pinned `node:XX-slim` tag, non-root `USER node`).
- Build all three images locally (`docker build`) and run Trivy against the local image tags.
- No push here — there is no registry to push to until Phase 5.
- **Done when:** all three images build clean and pass (or have triaged) the Trivy scan, running locally via `docker run` reproduces Phase 2's end-to-end result.

## Phase 4 — Cloud bootstrap (one-time, manual)

This is the one deliberate exception to "everything through Terraform" — nothing else exists yet for Terraform or GitHub Actions to authenticate as, so a human has to create the first few things by hand (or via a small local-state Terraform run using your own `az login`).

- Create the resource group(s) for the environment(s) (e.g. `paybridge-dev-rg`), pinned to Canada Central.
- Create the storage account + blob container that will hold Terraform's remote state.
- Create the Azure AD app registration (or user-assigned identity) + federated credential trusting this GitHub repo/branch — the **deploy identity**.
- Grant the deploy identity Contributor scoped to the resource group only (not subscription-wide).
- Point `infra/backend.tf` at the new remote state storage account.
- **Done when:** `terraform init` succeeds against the remote backend, and a throwaway GitHub Actions run using `azure/login` with this federated credential can successfully list resources in the resource group.

## Phase 5 — Core cloud infrastructure (Terraform, applied manually for now)

Applied from your machine with your own `az login` — CI/CD doesn't take over Terraform applies until Phase 9. Everything here is a resource that does **not** need to sit inside a VNet.

- `infra/modules/`: network (VNet, app subnet, data subnet, NSGs — app subnet → data subnet allowed on 1433 only, deny otherwise), acr, keyvault, servicebus (topic `payments` + 2 filtered subscriptions), monitoring (Log Analytics + Application Insights), the runtime user-assigned managed identity. All resources pinned to Canada Central.
- `infra/envs/dev`: root module wiring these together with dev-sized SKUs.
- **Done when:** every resource above exists and is visible via `az resource list` — no application connectivity is expected or tested yet.

## Phase 6 — Data tier & private networking

The trickiest dependency chain in the project: `VNet/data subnet → SQL (public access disabled) → private endpoint → private DNS zone → DNS zone linked to VNet → Container Apps Environment injected into the app subnet`. Skipping any link breaks connectivity in a way that's hard to diagnose later — this is deliberately its own phase.

- Create the Azure SQL logical server + database with public network access disabled from creation (never briefly public).
- Create the private endpoint into the data subnet.
- Create the private DNS zone (`privatelink.database.windows.net`) and link it to the VNet — the classic missed step.
- Create the Container Apps Environment, VNet-integrated into the app subnet (required for it to ever reach the private SQL endpoint or Service Bus over private networking later).
- **Done when:** from something already inside the VNet (a throwaway Container Apps Job running a public base image — nothing of ours is in ACR yet, so it can't pull from there), the SQL private DNS name resolves and a TCP connection to port 1433 succeeds. No application code involved yet — this proves the network path, not the app.

## Phase 7 — Identity, RBAC & secrets

Creating a resource is not the same as being allowed to use it. This phase turns "exists" into "usable."

- Assign roles to the **runtime identity**: Key Vault Secrets User (scoped to the Key Vault), AcrPull (scoped to the ACR), Service Bus Data Sender + Data Receiver (scoped to the namespace/topic).
- Configure SQL access for the runtime identity (Azure AD auth, or generate SQL auth credentials) — either way, the credential/connection info lands in Key Vault next.
- Populate Key Vault secrets: Stripe webhook signing secret, SQL connection credentials, email provider API key.
- Provision the confirmation-email provider (Azure Communication Services or SendGrid) and store its key in Key Vault.
- Push the Phase 3 images to ACR now that it exists and you're authenticated (`az acr login` + `docker push`, manually for now) — needed so the next step has something real to test against.
- **Done when:** a throwaway job running under the runtime identity can (a) read a test secret from Key Vault via `DefaultAzureCredential`, (b) pull one of the just-pushed application images from ACR, and (c) send a test message to the Service Bus topic. Prove each RBAC edge works in isolation before the real app depends on all three at once.

## Phase 8 — Deploy to Container Apps

- Run the schema migration/init against the cloud SQL database from inside the VNet (e.g. a one-off Container Apps Job using the Phase 7 image — there is no public path to SQL, so this cannot run from your laptop).
- Deploy the 3 Container Apps into the Phase 6 environment: attach the runtime identity, wire the real `queue` (Service Bus) and `email` implementations, pull config/secrets from Key Vault.
- Point the real Stripe webhook (test mode) at the deployed `ingest-api` URL; point the QB mock timer at it too.
- **Done when:** the same end-to-end result as Phase 2 — payment in → normalized → routed by source → row in Azure SQL → confirmation sent → visible via the reconciliation API — now happens in Azure instead of locally.

## Phase 9 — CI/CD automation

Only automate a path you've already proven manually in Phases 4–8.

- `.github/workflows/`: PR pipeline (lint → test → build → Trivy scan → `terraform plan`, posted to the PR) and main-branch pipeline (`terraform apply` → build+push to ACR → deploy new Container Apps revision).
- Both authenticate via `azure/login` using the Phase 4 **deploy identity** federated credential — no stored secrets in GitHub.
- **Done when:** a trivial merge to main flows through the pipeline unattended and updates the running Container App revision, with no manual `az`/`terraform`/`docker` commands.

## Phase 10 — Observability

- Instrument the App Insights SDK in all three services (connection info already available via Key Vault/app settings since Phase 7/8).
- Propagate a correlation ID: ingest → Service Bus message property → processor, so one trace spans the whole journey.
- Write and save 2 KQL queries against the Log Analytics workspace (e.g. failed payments in the last 24h, dead-letter count by hour).
- Create an Azure Monitor alert rule on the Service Bus dead-letter count metric > 0, wired to an action group (email).
- **Done when:** deliberately sending a malformed payload causes a message to dead-letter and the alert actually fires.

## Phase 11 — AKS (v2)

Reuses the ACR images already built — no rebuild. New dependencies specific to this phase: an AKS-dedicated subnet, and AKS's own Workload Identity trust chain (parallel to, not reusing, the Container Apps identity attachment mechanism).

- Add a new subnet for the AKS node pool (VNet already exists from Phase 5; this subnet is new).
- Provision the AKS cluster in that subnet with the OIDC issuer enabled.
- Create a federated credential linking a Kubernetes ServiceAccount to the runtime identity (or a new identity with the same role assignments as Phase 7: Key Vault Secrets User, AcrPull, Service Bus Sender/Receiver).
- `k8s/` manifests: Deployment (referencing the existing ACR image tags) + Service + Ingress per service, ServiceAccount annotated for workload identity, HPA, resource requests/limits, liveness/readiness probes hitting `/health`.
- **Done when:** the same end-to-end test from Phase 8 passes with traffic served from AKS instead of Container Apps.
