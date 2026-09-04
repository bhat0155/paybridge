# CLAUDE.md — PayBridge

Context file for working on PayBridge. Read this fully before proposing changes. This is a portfolio project by Ekam Bhatia built to demonstrate real, defensible Azure cloud/DevOps skills. Everything here should be buildable and explainable in an interview — no hand-waving, no fabricated capability. If a capability isn't built yet, it's marked as such.

## 1. What this project is (one paragraph)

PayBridge is an event-driven payment integration & reconciliation pipeline. Businesses take money through one system (the "money-mover", e.g. Stripe) and keep their books in another (the "ledger", e.g. QuickBooks). Those systems don't talk, so someone reconciles them by hand — matching charges to invoices, marking them paid, emailing confirmations. PayBridge automates that: it catches each payment event, normalizes both sources into one common schema, routes by source (the Stripe-vs-QuickBooks "bifurcation"), records and reconciles it, sends a confirmation, and exposes one API to check the status of any payment.

Why it exists (the pain): fragmented payment data + manual matching → missed payments (silent, financial), wrong matches, late/absent confirmations, no single source of truth, and it gets worse as volume grows.

Why it's built the way it is: it handles money, so it must be always-on, must never drop an event, must alert the instant something fails, and must scale. That's why it uses durable messaging, private networking, secret isolation, infrastructure-as-code, and observability — not because they're buzzwords, but because money demands them.

## 2. Success criteria

- A simulated payment (from Stripe test mode and a mock QuickBooks feed) flows end-to-end: ingested → normalized → routed by source → stored → confirmation sent → visible via the reconciliation API.
- No payment event is lost even if a consumer is temporarily down (durable queue).
- The database has no public endpoint.
- No secrets in code — all via Key Vault + managed identity.
- The entire cloud footprint is provisioned by Terraform (reproducible, dev + prod).
- CI/CD builds, tests, scans, and deploys automatically; deploy auth uses short-lived OIDC tokens, not stored secrets.
- Observability: distributed traces, queryable logs, and an alert on failed/dead-lettered payments.
- Deployed to Azure Container Apps (v1) and then AKS (v2), pinned to Canada Central (data residency).

## 3. Architecture

```
   Stripe (test mode)          "QuickBooks" mock feed
   webhook  ─────────┐         (timer-emitted JSON) ────────┐
                     ▼                                       ▼
             ┌──────────────────────────────────────────────────┐
             │  Ingest API            (container #1)             │
             │  - verifies webhook signature                     │
             │  - normalizes payload → common schema             │
             └───────────────┬──────────────────────────────────┘
                             ▼  publish message
                   Azure Service Bus  (topic: "payments")
                   ├── subscription: stripe      (filter source = 'stripe')
                   └── subscription: quickbooks  (filter source = 'qb')
                             ▼  consume
             ┌──────────────────────────────────────────────────┐
             │  Processor             (container #2, worker)     │
             │  - writes record to Azure SQL (via priv endpoint) │
             │  - sends confirmation email                       │
             └───────────────┬──────────────────────────────────┘
                             ▼
                   Azure SQL Database  (private endpoint only)
                             ▲
             ┌───────────────┴──────────────────────────────────┐
             │  Reconciliation API    (container #3, read side)  │
             │  GET /transactions?source=stripe|quickbooks       │
             │  returns reconciled/bifurcated records            │
             └──────────────────────────────────────────────────┘
```

Cross-cutting:
- Key Vault (Stripe key, SQL creds, email creds) ← accessed via user-assigned Managed Identity
- App Insights + Log Analytics (traces, logs, metrics, alerts)
- One VNet; subnets per tier; NSGs restrict traffic; SQL reachable only via private endpoint
- All infra provisioned by Terraform; all app deploys via GitHub Actions (OIDC to Azure)
- Region: Canada Central

The Service Bus topic with two filtered subscriptions IS the bifurcation — the Stripe-vs-QuickBooks routing, as a clean, explainable pattern.

## 4. Tech stack and the reason for each choice

| Layer | Choice | Why this (and the trade-off) |
|---|---|---|
| Language / services | Node.js + TypeScript (Express for APIs) | Matches existing strength; types reduce bugs in money code. (Python/FastAPI is an equally valid alt.) |
| Packaging | Docker (multi-stage, non-root, pinned base) | Standard, portable, kills "works on my machine". Near-zero downside. |
| Runtime v1 | Azure Container Apps | Managed orchestration — fast to stand up. Less control than raw K8s. |
| Runtime v2 | Azure Kubernetes Service (AKS) | Full control + portability + market expectation. Cost: operational overhead. Do it after v1 works. |
| Messaging | Azure Service Bus (topic + 2 subscriptions) | Durable (never drops a payment), decouples producers/consumers, filtered subscriptions = source routing. Adds a moving part, but it's the reliability backbone. |
| Database | Azure SQL + private endpoint | Structured, relational financial data; private endpoint removes public attack surface. Less flexible than NoSQL — which is desirable here. |
| Networking | VNet + subnets + NSGs | Defense in depth; only the app tier can reach the DB. Adds config complexity, worth it for money. |
| Secrets/identity | Key Vault + user-assigned Managed Identity | No secrets in code; app authenticates by identity, not password → almost nothing to leak. |
| IaC | Terraform (remote state, dev/prod) | Reproducible, reviewable, rebuildable. Upfront effort; huge long-term payoff. This is the flagship skill. |
| CI/CD | GitHub Actions (build → test → Trivy scan → deploy) | Consistency + defect gates before prod. |
| Deploy auth | OIDC federated credentials | Short-lived token per run; no stored long-lived secret in GitHub. |
| Confirmation email | Azure Communication Services (or SendGrid) | Managed email send; keep provider swappable behind an interface. |
| Observability | Azure Monitor + Application Insights + Log Analytics (KQL) | Traces + searchable logs + metric alerts. Can't fix what you can't see. |
| Registry | Azure Container Registry (ACR) | Private image store the runtime pulls from. |
| Region | Canada Central | Data residency — matters in the Ottawa/public-sector market. |

## 5. Proposed repository structure

```
paybridge/
├── CLAUDE.md                  ← this file
├── README.md                  ← public-facing overview + architecture diagram
├── services/
│   ├── ingest-api/            ← catches + normalizes payment events
│   ├── processor/             ← consumes queue, writes DB, sends confirmation
│   └── reconciliation-api/    ← read API: status + bifurcated records
├── shared/                    ← common schema, types, helpers (the "one language")
├── infra/                     ← Terraform (modules + dev/prod configs)
│   ├── modules/               ← network, sql, servicebus, keyvault, monitoring, compute
│   ├── envs/
│   │   ├── dev/
│   │   └── prod/
│   └── backend.tf             ← remote state config
├── .github/workflows/         ← CI/CD pipelines
├── k8s/                       ← AKS manifests (v2): deployments, services, ingress, HPA, probes
├── docker/                    ← Dockerfiles / compose for local
└── docs/                      ← notes, runbooks, incident write-ups ("production scars")
```

## 6. Local development (Phase 0 — do this first)

- `docker compose up` runs all three services + a local SQL container.
- Use Stripe test mode (real API, real webhook signatures, free) for the money-mover side.
- Use a timer that emits mock invoice JSON in the same shape for the QuickBooks side — do NOT wire a real client system.
- Definition of done for Phase 0: fake payment in → row in DB → confirmation logged → visible in reconciliation API. No cloud yet.

## 7. Build roadmap (phased — each phase earns the next)

- [ ] Phase 0 — Local: 3 services + local SQL via compose; end-to-end works locally.
- [ ] Phase 1 — Containerize: multi-stage Dockerfiles, non-root, push to ACR, Trivy scan.
- [ ] Phase 2 — IaC (Terraform): RG, VNet/subnets/NSGs, ACR, Key Vault, Azure SQL + private endpoint, Service Bus (topic + 2 subs), Log Analytics + App Insights, compute, user-assigned managed identity + RBAC. Remote state in a storage account. dev/prod separation. (Biggest skill gap — do carefully.)
- [ ] Phase 3 — Networking: enforce subnet isolation; DB private-endpoint only; ingress via Container Apps / App Gateway. Be able to draw it from memory.
- [ ] Phase 4 — Identity & secrets: all secrets in Key Vault; app reads them via managed identity; least-privilege RBAC.
- [ ] Phase 5 — CI/CD: GitHub Actions lint → test → build → scan → push → terraform plan → deploy; OIDC auth; plan gated on PRs.
- [ ] Phase 6 — Observability: App Insights tracing across ingest→queue→processor; ship logs to Log Analytics; write 2 KQL queries; alert on dead-letter count > 0.
- [ ] Phase 7 — AKS (v2): redeploy same images; Deployments, Service, Ingress, HPA, requests/limits, liveness/readiness probes, workload identity.

## 8. Conventions & guardrails (follow these when generating code/infra)

- Never put secrets in code, config files, or env files committed to git. Always Key Vault + managed identity. No connection strings in plaintext.
- All infrastructure changes go through Terraform. Do not suggest clicking in the Azure Portal for anything persistent ("no click-ops").
- Pin the region to Canada Central on every resource.
- The database must never expose a public endpoint. Access only via private endpoint from the app subnet.
- Idempotency matters for money: processing the same payment event twice must not double-record. Design consumers to be safe on retry (dedupe on a payment/event id).
- Nothing may silently drop a payment. Failed messages go to a dead-letter queue AND raise an alert; never swallow errors.
- Normalize at ingest. Downstream code works only with the common schema, never raw provider payloads.
- Least privilege on every RBAC role assignment (e.g. "Key Vault Secrets User", not "Owner").
- Docker: multi-stage builds, pinned base image tags (no `latest` in prod), run as non-root.
- Keep the email provider behind an interface so it can be swapped.
- Tests required for the normalization and routing logic — that's where correctness of the money lives.

## 9. Testing & deliberate failure drills ("production scars")

After it works, intentionally break it and practice recovery. Document each in `docs/` as: what broke → how I found it → what I changed.

- Dead-lettered messages — push a malformed payload; confirm it dead-letters after max delivery; add validation + DLQ alert.
- Private DNS not linked — app can't resolve SQL because the private DNS zone isn't linked to the VNet; link it. (Classic; happens to everyone.)
- Managed identity RBAC wrong/lagging — app gets 403 from Key Vault; diagnose scope, fix role assignment.
- Runaway cost — spot an over-provisioned/high-ingestion resource in Cost Management; right-size / sample telemetry.
- Bad deploy + rollback — ship a broken image; readiness probe fails; roll back the Deployment.

These double as real interview stories ("tell me about a time something broke").

## 10. Glossary / interview cheat-sheet (plain-English + example)

- **Reconciliation** — matching money that arrived to what was owed. Example: checking your bank statement against your receipts.
- **Normalize** — rewrite different providers into one common format before comparing. Example: "03/04" (Mar 4 vs Apr 3); "Robert Smith" vs "Bob S.".
- **Bifurcation / routing by source** — separate real payments from ledger records; handle each correctly. Example: cash in hand vs an IOU note.
- **Message queue (Service Bus)** — durable middle layer so nothing is lost and pieces are decoupled. Example: a restaurant ticket rail that can't drop a ticket.
- **Private endpoint** — DB reachable only from inside the private network, no public door. Example: a vault in a back room with no street entrance.
- **Managed identity** — app proves who it is instead of carrying a password. Example: hotel keycard vs. key under the doormat.
- **Infrastructure as Code (Terraform)** — build all infra from reviewable, repeatable files. Example: IKEA instructions vs. building from memory.
- **CI/CD pipeline** — automated build→test→scan→deploy on every change. Example: a car assembly line with inspection stations.
- **OIDC deploy token** — short-lived credential for a deploy, no stored password. Example: a day pass vs. a permanent key.
- **Observability (traces/logs/alerts)** — see each payment's journey; get pinged on failure. Example: car dashboard + smoke alarm.
- **Container (Docker)** — app + everything it needs in one portable box. Example: a shipping container.
- **AKS vs Container Apps** — full-control orchestration vs managed. Example: manual car vs automatic.
