# Phase 2 — Local integration

Source: `phases.md` → Phase 2. Goal: every no-op stub from Phase 1 becomes a real, working piece — real queue, real DB writes, real (console) email — while everything still runs on one laptop, no Azure involved. This is the phase where the actual money-handling logic (normalization, routing by source, idempotent writes) gets written for the first time.

## Steps

### 1. Local secrets — `.env` (gitignored) + `.env.example` (committed)

**Why:** local-only convenience per `phases.md` — this pattern goes away the moment we touch the cloud (Phase 7 uses Key Vault instead). `.env.example` is committed as a template so the repo documents what variables exist without leaking real values.

`.env.example` at repo root:
```
SQL_SA_PASSWORD=ChangeMe_Local_Only1
SQL_HOST=localhost
SQL_PORT=1433
SQL_USER=sa
REDIS_URL=redis://localhost:6379
STRIPE_WEBHOOK_SECRET=whsec_replace_with_stripe_listen_output
INGEST_API_URL=http://localhost:3001
```
Copy it to `.env` and fill in real local values. `.env` is already covered by `.gitignore` from Phase 1.

### 2. `docker-compose.yml` — Redis + SQL only

**Why:** Phase 2 needs a real database and a real queue transport to develop against. It deliberately does **not** containerize `ingest-api`/`processor`/`reconciliation-api` themselves — that requires a proper multi-stage Dockerfile per service, which is explicitly `phases.md`'s **Phase 3** job. Building throwaway Dockerfiles now would just be redone (and wasted) one phase later. The three services keep running on the host via `npm run dev:*`, pointed at the container ports below.

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

volumes:
  paybridge-sql-data:
```
Azure SQL Edge is Microsoft's real, small, locally-runnable substitute for Azure SQL — same wire protocol, since actual Azure SQL can't run on a laptop.

### 3. `shared/src/db.ts` — DB pool + schema init

**Why:** both `processor` (writes) and `reconciliation-api` (reads) need the same connection pool and the same table — a genuine shared helper, unlike the queue/email implementations which are one-sided. This is also where the schema init from `phases.md` lives: an empty SQL container has no tables, so something has to create `payments` before anything can be written to it. Making it idempotent (`IF NOT EXISTS`) means it's safe to call every time a service starts, not just once.

Note the `UNIQUE (source, source_event_id)` constraint — this is what makes retries safe per `CLAUDE.md`'s guardrail ("processing the same payment event twice must not double-record").

```ts
// shared/src/db.ts
import sql from "mssql";

const baseConfig = {
  server: process.env.SQL_HOST ?? "localhost",
  port: Number(process.env.SQL_PORT ?? 1433),
  user: process.env.SQL_USER ?? "sa",
  password: process.env.SQL_SA_PASSWORD,
  options: { trustServerCertificate: true, enableArithAbort: true },
};

let pool: sql.ConnectionPool | null = null;

export async function getPool(): Promise<sql.ConnectionPool> {
  if (!pool) {
    pool = await new sql.ConnectionPool({ ...baseConfig, database: "paybridge" }).connect();
  }
  return pool;
}

export async function ensureSchema(): Promise<void> {
  const master = await new sql.ConnectionPool({ ...baseConfig, database: "master" }).connect();
  await master.request().query(`IF DB_ID('paybridge') IS NULL CREATE DATABASE paybridge;`);
  await master.close();

  const db = await getPool();
  await db.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'payments')
    CREATE TABLE payments (
      record_id UNIQUEIDENTIFIER PRIMARY KEY,
      source NVARCHAR(10) NOT NULL,
      source_event_id NVARCHAR(255) NOT NULL,
      amount DECIMAL(10,2) NOT NULL,
      currency NVARCHAR(3) NOT NULL,
      customer_name NVARCHAR(255) NOT NULL,
      description NVARCHAR(500) NOT NULL,
      status NVARCHAR(50) NOT NULL,
      event_timestamp DATETIME2 NOT NULL,
      CONSTRAINT UQ_payments_source_event UNIQUE (source, source_event_id)
    );
  `);
}
```
Add `"mssql": "^11.0.1"` to `shared/package.json` dependencies, and export `db.ts` from `shared/src/index.ts` (`export * from "./db";`).

### 4. Real queue — Redis, one list, both sources

**Why Redis over pure in-memory:** `ingest-api` and `processor` are two separate OS processes (started independently). An in-memory queue only works within a single process's memory — it physically cannot carry a message from one process to another. Redis is the smallest real thing that can.

**Why one list, not two:** the real Service Bus topic will have two *filtered subscriptions* (Phase 5) — that's the actual "bifurcation." Locally, `processor` already consumes both sources into one handler (see the architecture diagram in `CLAUDE.md` — one processor, one arrow in), so mirroring two separate lists here would be complexity with no payoff. `source` is already on every record; that's enough to distinguish them downstream.

**Why a Redis *list* over pub/sub:** pub/sub drops a message if nothing is subscribed at that instant — the opposite of "never drop a payment." A list (`LPUSH`/`BRPOP`) holds messages until something pops them, which is closer in spirit to what Service Bus does later.

`services/ingest-api/src/redisQueue.ts`:
```ts
import { createClient } from "redis";
import type { QueuePublisher, PaymentRecord } from "@paybridge/shared";

const QUEUE_KEY = "payments";

export class RedisQueuePublisher implements QueuePublisher {
  private client = createClient({ url: process.env.REDIS_URL ?? "redis://localhost:6379" });
  private ready = this.client.connect();

  async publish(event: PaymentRecord): Promise<void> {
    await this.ready;
    await this.client.lPush(QUEUE_KEY, JSON.stringify(event));
  }
}
```

`services/processor/src/redisQueue.ts`:
```ts
import { createClient } from "redis";
import type { QueueConsumer, PaymentRecord } from "@paybridge/shared";

const QUEUE_KEY = "payments";

export class RedisQueueConsumer implements QueueConsumer {
  private client = createClient({ url: process.env.REDIS_URL ?? "redis://localhost:6379" });

  consume(handler: (event: PaymentRecord) => Promise<void>): void {
    void this.loop(handler);
  }

  private async loop(handler: (event: PaymentRecord) => Promise<void>): Promise<void> {
    await this.client.connect();
    for (;;) {
      const popped = await this.client.brPop(QUEUE_KEY, 0);
      if (!popped) continue;
      await handler(JSON.parse(popped.element) as PaymentRecord);
    }
  }
}
```
Delete `noopQueue.ts` in both services — superseded, no longer used. Add `"redis": "^4.7.0"` to both `package.json`s.

### 5. Real email — console logger (`processor` only)

**Why:** `phases.md` only asks for console/log output at this phase; a real provider (Azure Communication Services/SendGrid) is cloud-side, Phase 7/8. Only `processor` needs this — it's the one service with the `EmailSender` interface, per Phase 1.

`services/processor/src/consoleEmail.ts`:
```ts
import type { EmailSender, PaymentRecord } from "@paybridge/shared";

export class ConsoleEmailSender implements EmailSender {
  async sendConfirmation(record: PaymentRecord): Promise<void> {
    console.log(
      `[email] confirmation sent to ${record.customer_name} for ${record.source} payment ${record.source_event_id} ($${record.amount} ${record.currency})`
    );
  }
}
```
Delete `noopEmail.ts` — superseded.

### 6. Normalization + both webhook routes (`ingest-api`)

**Why this is the money-critical logic:** per `contracts.md`, Stripe sends cents nested under `data.object`, QuickBooks sends dollars flat — normalization is what makes both look identical downstream. `CLAUDE.md` explicitly requires tests for this logic (step 10 below).

`services/ingest-api/src/normalize.ts`:
```ts
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import type { PaymentRecord } from "@paybridge/shared";

export function normalizeStripeEvent(event: Stripe.Event): PaymentRecord {
  const charge = event.data.object as Stripe.Charge;
  return {
    record_id: randomUUID(),
    source: "stripe",
    source_event_id: charge.id,
    amount: charge.amount / 100,
    currency: charge.currency.toUpperCase(),
    customer_name: charge.billing_details?.name ?? "unknown",
    description: charge.description ?? "",
    status: charge.status,
    event_timestamp: new Date(charge.created * 1000).toISOString(),
  };
}

interface QuickBooksInvoicePayload {
  invoice_id: string;
  customer: string;
  amount_due: number;
  currency: string;
  memo: string;
  status: string;
  issued_date: string;
}

export function normalizeQuickBooksEvent(payload: QuickBooksInvoicePayload): PaymentRecord {
  return {
    record_id: randomUUID(),
    source: "qb",
    source_event_id: payload.invoice_id,
    amount: payload.amount_due,
    currency: payload.currency,
    customer_name: payload.customer,
    description: payload.memo,
    status: payload.status,
    event_timestamp: new Date(payload.issued_date).toISOString(),
  };
}
```
**Note (deferred, not forgotten):** `contracts.md` section 4 flags the status-vocabulary question (`"succeeded"` vs `"paid"`) as an open decision. Phase 2 keeps each source's native status word as-is — mapping to one shared vocabulary is a decision for later, not silently made here.

`services/ingest-api/src/index.ts` — replaces the Phase 1 stub. Two changes from Phase 1 worth flagging: (1) a real `POST /webhooks/quickbooks` route now exists (Phase 1 only had the Stripe placeholder); (2) the Stripe route needs the **raw** request body for signature verification, so it can't share a global `express.json()` — each route declares its own body parser.
```ts
import "dotenv/config";
import express from "express";
import Stripe from "stripe";
import { PaymentRecordSchema } from "@paybridge/shared";
import { RedisQueuePublisher } from "./redisQueue";
import { normalizeStripeEvent, normalizeQuickBooksEvent } from "./normalize";

const app = express();
const publisher = new RedisQueuePublisher();
// Only used to call stripe.webhooks.constructEvent() — never makes a real Stripe API call.
const stripe = new Stripe(process.env.STRIPE_API_KEY ?? "sk_test_not_used_for_webhook_verification");

app.post("/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"] as string,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch {
    return res.status(400).send("signature verification failed");
  }

  const record = PaymentRecordSchema.parse(normalizeStripeEvent(event));
  await publisher.publish(record);
  res.status(202).send();
});

app.post("/webhooks/quickbooks", express.json(), async (req, res) => {
  const record = PaymentRecordSchema.parse(normalizeQuickBooksEvent(req.body));
  await publisher.publish(record);
  res.status(202).send();
});

const port = process.env.PORT ?? 3001;
app.listen(port, () => {
  console.log(`ingest-api listening on port ${port}`);
});
```
Add `"stripe": "^16.9.0"` and `"dotenv": "^16.4.5"` to `ingest-api/package.json`.

### 7. `processor` — consume, write with dedupe, confirm

**Why the try/catch on insert:** this is the idempotency guardrail from `CLAUDE.md` in code — the DB's `UNIQUE (source, source_event_id)` constraint (step 3) rejects a duplicate insert with SQL error 2627/2601. Catching that specifically and skipping (instead of crashing, and instead of sending a second confirmation email) is what "safe on retry" means in practice.

```ts
// services/processor/src/index.ts
import "dotenv/config";
import { getPool, ensureSchema } from "@paybridge/shared";
import { RedisQueueConsumer } from "./redisQueue";
import { ConsoleEmailSender } from "./consoleEmail";

const consumer = new RedisQueueConsumer();
const emailSender = new ConsoleEmailSender();

async function main() {
  await ensureSchema();
  const pool = await getPool();

  consumer.consume(async (event) => {
    try {
      await pool
        .request()
        .input("record_id", event.record_id)
        .input("source", event.source)
        .input("source_event_id", event.source_event_id)
        .input("amount", event.amount)
        .input("currency", event.currency)
        .input("customer_name", event.customer_name)
        .input("description", event.description)
        .input("status", event.status)
        .input("event_timestamp", new Date(event.event_timestamp))
        .query(`
          INSERT INTO payments
            (record_id, source, source_event_id, amount, currency, customer_name, description, status, event_timestamp)
          VALUES
            (@record_id, @source, @source_event_id, @amount, @currency, @customer_name, @description, @status, @event_timestamp)
        `);
    } catch (err: any) {
      if (err.number === 2627 || err.number === 2601) {
        console.log(`[processor] duplicate event ${event.source_event_id} — already processed, skipping`);
        return;
      }
      throw err;
    }

    await emailSender.sendConfirmation(event);
  });

  console.log("processor started");
}

main();
```
Add `"dotenv": "^16.4.5"` to `processor/package.json`.

### 8. `reconciliation-api` — real read

```ts
// services/reconciliation-api/src/index.ts
import "dotenv/config";
import express from "express";
import { getPool } from "@paybridge/shared";
import type { PaymentRecord } from "@paybridge/shared";

const app = express();

app.get("/transactions", async (req, res) => {
  const source = typeof req.query.source === "string" ? req.query.source : null;
  const pool = await getPool();
  const result = await pool
    .request()
    .input("source", source)
    .query(`SELECT * FROM payments WHERE (@source IS NULL OR source = @source) ORDER BY event_timestamp DESC`);
  res.json(result.recordset as PaymentRecord[]);
});

const port = process.env.PORT ?? 3003;
app.listen(port, () => {
  console.log(`reconciliation-api listening on port ${port}`);
});
```
Add `"dotenv": "^16.4.5"` to `reconciliation-api/package.json`.

### 9. QuickBooks mock timer

**Why it's a standalone script, not a fourth service:** per `CLAUDE.md`, this simulates an external system PayBridge doesn't own — "do NOT wire a real client system." It lives at `scripts/qb-mock.ts`, outside the `services/` tree, run manually while developing.

```ts
// scripts/qb-mock.ts
import "dotenv/config";

const INGEST_URL = process.env.INGEST_API_URL ?? "http://localhost:3001";
const INTERVAL_MS = 30_000;
let counter = 0;

async function fireMockInvoice() {
  counter += 1;
  const payload = {
    invoice_id: `INV-MOCK-${Date.now()}-${counter}`,
    customer: "John Smith",
    amount_due: 20.0,
    currency: "USD",
    memo: "Pizza order #482",
    status: "paid",
    issued_date: new Date().toISOString().slice(0, 10),
  };

  const response = await fetch(`${INGEST_URL}/webhooks/quickbooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  console.log(`[qb-mock] sent ${payload.invoice_id} → ${response.status}`);
}

console.log(`[qb-mock] firing a mock invoice every ${INTERVAL_MS / 1000}s`);
setInterval(fireMockInvoice, INTERVAL_MS);
fireMockInvoice();
```

### 10. Tests for normalization (`CLAUDE.md` guardrail: "tests required for normalization and routing logic")

`services/ingest-api/src/normalize.test.ts` — uses the exact worked example from `contracts.md` §3 as the test fixture:
```ts
import { describe, expect, it } from "vitest";
import { normalizeStripeEvent, normalizeQuickBooksEvent } from "./normalize";

describe("normalizeStripeEvent", () => {
  it("converts cents to dollars and extracts the billing name", () => {
    const event = {
      data: {
        object: {
          id: "ch_3NxAB2K",
          amount: 2000,
          currency: "usd",
          billing_details: { name: "John Smith" },
          description: "Pizza order #482",
          status: "succeeded",
          created: 1767456000,
        },
      },
    } as any;

    const record = normalizeStripeEvent(event);

    expect(record.amount).toBe(20);
    expect(record.currency).toBe("USD");
    expect(record.customer_name).toBe("John Smith");
    expect(record.source_event_id).toBe("ch_3NxAB2K");
  });
});

describe("normalizeQuickBooksEvent", () => {
  it("maps invoice_id to source_event_id and passes amount through unchanged", () => {
    const record = normalizeQuickBooksEvent({
      invoice_id: "INV-1042",
      customer: "John Smith",
      amount_due: 20.0,
      currency: "USD",
      memo: "Pizza order #482",
      status: "paid",
      issued_date: "2026-09-03",
    });

    expect(record.source).toBe("qb");
    expect(record.source_event_id).toBe("INV-1042");
    expect(record.amount).toBe(20.0);
  });
});
```
Add `"vitest": "^2.1.1"` as a devDependency and a `"test": "vitest run"` script to `ingest-api/package.json`.

### 11. Root wiring

Add to root `package.json`:
```json
"scripts": {
  "db:up": "docker compose up -d",
  "db:down": "docker compose down",
  "dev:ingest": "dotenv -e .env -- npm run dev -w services/ingest-api",
  "dev:processor": "dotenv -e .env -- npm run dev -w services/processor",
  "dev:reconciliation": "dotenv -e .env -- npm run dev -w services/reconciliation-api",
  "mock:qb": "dotenv -e .env -- tsx scripts/qb-mock.ts",
  "test": "npm run test --workspaces --if-present"
}
```
Add root devDependencies: `"dotenv-cli": "^7.4.2"`, `"tsx": "^4.16.2"`, `"typescript": "^5.5.4"` (needed to run `scripts/qb-mock.ts`, which sits outside any workspace). `dotenv-cli` loads the root `.env` regardless of which workspace folder `npm -w` changes into — avoids fragile relative paths from each service back to the root.

## Verification

```
cp .env.example .env          # fill in real local values
npm run db:up                 # starts Redis + SQL containers
npm install
npm run build                 # must compile clean across all 4 packages
npm run test                  # normalization unit tests must pass

# separate terminals:
npm run dev:processor         # creates DB + table on startup, logs "processor started"
npm run dev:ingest            # logs "ingest-api listening on port 3001"
npm run dev:reconciliation    # logs "reconciliation-api listening on port 3003"

# another terminal — real signed Stripe webhook:
stripe listen --forward-to localhost:3001/webhooks/stripe
# copy the printed whsec_... into .env as STRIPE_WEBHOOK_SECRET, restart dev:ingest
stripe trigger charge.succeeded

# another terminal — QuickBooks mock:
npm run mock:qb

# confirm both landed:
curl http://localhost:3003/transactions
curl http://localhost:3003/transactions?source=stripe
curl http://localhost:3003/transactions?source=qb

# idempotency check — re-send an identical qb payload twice (same invoice_id) and
# confirm processor logs "duplicate event ... skipping" and only one row exists.
```

## Hands-on scenarios — replicate these yourself

The `Verification` block above is the terse command list. This section is the same thing broken into scenarios with **what you should actually see** and **what it proves**, so you can run each one yourself and watch the system behave, not just trust that it compiled.

Run Scenario 1 once. Scenarios 2–8 can be run in any order after that, but 4 depends on 3, and 6 depends on 5.

### Scenario 1 — First-time setup

```
cp .env.example .env
npm run db:up
npm install
npm run build
npm run test
```
**What you should see:** `docker compose ps` shows `paybridge-redis-1` and `paybridge-sql-1` both `Up`. `npm run build` ends with no `tsc` errors across all 4 packages. `npm run test` prints `2 passed (2)`.
**What this proves:** the code compiles and the two infra dependencies (Redis, SQL) are reachable — nothing about the app itself yet.

### Scenario 2 — Start all three services, watch the schema get created

In three separate terminals:
```
npm run dev:processor
npm run dev:ingest
npm run dev:reconciliation
```
**What you should see:** `processor` logs `processor started` (only after it silently created the `paybridge` database and `payments` table — first run only, later runs skip straight to this line since the table already exists). `ingest-api` logs `ingest-api listening on port 3001`. `reconciliation-api` logs `reconciliation-api listening on port 3003`.
**What this proves:** the idempotent schema-init logic in `shared/src/db.ts` works, and all three processes start clean with real (not no-op) dependencies wired in.

### Scenario 3 — A fake QuickBooks payment, end to end

In a fourth terminal:
```
curl -s -X POST http://localhost:3001/webhooks/quickbooks \
  -H "Content-Type: application/json" \
  -d '{
    "invoice_id": "INV-1042",
    "customer": "John Smith",
    "amount_due": 20.00,
    "currency": "USD",
    "memo": "Pizza order #482",
    "status": "paid",
    "issued_date": "2026-09-03"
  }'
```
**What you should see:** the curl returns `202`. The `processor` terminal immediately logs `[email] confirmation sent to John Smith for qb payment INV-1042 ($20 USD)`. Then:
```
curl -s http://localhost:3003/transactions?source=qb
```
returns a JSON array with one object — `source_event_id: "INV-1042"`, `amount: 20`, `customer_name: "John Smith"`.
**What this proves:** the full chain — ingest → normalize → Redis → processor → SQL write → confirmation → read API — works for a payload that never touches Stripe at all.

### Scenario 4 — Idempotency: the same payment can't be recorded twice

Re-run the **exact same** curl command from Scenario 3 again.
**What you should see:** curl still returns `202` (ingest doesn't know it's a duplicate — that's `processor`'s job, not the webhook's). But the `processor` terminal now logs `[processor] duplicate event INV-1042 — already processed, skipping`, with **no** second `[email]` line. Re-run `curl -s http://localhost:3003/transactions?source=qb` — still exactly **one** row, not two.
**What this proves:** the `UNIQUE(source, source_event_id)` constraint from `shared/src/db.ts` plus the duplicate-key catch in `processor/src/index.ts` actually prevents double-recording — this is `CLAUDE.md`'s "processing the same payment event twice must not double-record" guardrail, working.

### Scenario 5 — A real, signed Stripe webhook

```
stripe login          # first time only — opens a browser, pick "Test mode"
stripe listen --forward-to localhost:3001/webhooks/stripe
```
Copy the `whsec_...` value it prints into `.env` as `STRIPE_WEBHOOK_SECRET`, then **restart** `dev:ingest` (env vars are only read once at startup) so it picks up the real secret. In another terminal:
```
stripe trigger charge.succeeded
```
**What you should see:** the `stripe listen` terminal shows one or more lines like `--> charge.succeeded [evt_...]` followed by `<-- [202] POST .../webhooks/stripe`. `processor` logs a confirmation. `curl -s http://localhost:3003/transactions?source=stripe` shows a row with `source_event_id` starting with `ch_`.
**What this proves:** `stripe.webhooks.constructEvent()` in `ingest-api/src/index.ts` is actually validating a real cryptographic signature from Stripe — not just trusting whatever arrives at the endpoint.

### Scenario 6 — Stripe sends more than you asked for

Look closely at the `stripe listen` output from Scenario 5 — you'll likely see **more than one** `-->` line (e.g. `payment_intent.created`, `payment_intent.succeeded`, `charge.updated`, alongside `charge.succeeded`), all for the one `stripe trigger` call.
**What you should see:** every event type gets a response, but only the `charge.succeeded` one is `202` (recorded) — the others come back `200` (acknowledged, not stored). Confirm with `curl -s http://localhost:3003/transactions?source=stripe`: still only **one** stripe row, even though Stripe sent 3–4 events.
**What this proves:** the `if (event.type !== "charge.succeeded")` check in `ingest-api/src/index.ts` — without it, `payment_intent.*` events get mis-recorded as if they were independent payments (this was a real bug caught by actually running this once — see the Phase 2 commit history).

### Scenario 7 — The queue protects payments when `processor` is down

Stop `processor` (Ctrl+C in its terminal) but leave `ingest-api` and Redis running. Send a new payment:
```
curl -s -X POST http://localhost:3001/webhooks/quickbooks \
  -H "Content-Type: application/json" \
  -d '{"invoice_id":"INV-DURABILITY-TEST","customer":"Jane Doe","amount_due":15,"currency":"USD","memo":"Coffee","status":"paid","issued_date":"2026-09-06"}'
```
**What you should see:** curl still returns `202` immediately — `ingest-api` doesn't care whether anything is downstream. Check `curl -s http://localhost:3003/transactions?source=qb` — `INV-DURABILITY-TEST` is **not** there yet (nothing has consumed it). Now run `npm run dev:processor` again. Within a second or two, it should log the confirmation, and the row now appears in `reconciliation-api`.
**What this proves:** this is the actual point of putting a queue between `ingest-api` and `processor` — a downed consumer doesn't lose the payment or block ingestion, it just waits in Redis until something's ready to consume it. This is the local stand-in for the "never drop a payment" guarantee `CLAUDE.md` describes (Service Bus does this for real in the cloud phases).

### Scenario 8 (bonus) — SQL data survives a restart, Redis data doesn't

```
docker compose restart sql
```
Wait ~15 seconds, then `curl -s http://localhost:3003/transactions` — all your earlier rows are still there.
**What this proves:** the `paybridge-sql-data` volume in `docker-compose.yml` is doing its job — SQL is the real source of truth and must survive a restart. (We deliberately did *not* give Redis a volume — try `docker compose restart redis` immediately after sending a payment but before `processor` consumes it, and that message is gone for good. That's the local trade-off flagged in Step 4 above: real durability for the queue itself arrives with Service Bus in Phase 5, not before.)

## Definition of Done (from `phases.md`)

> A fake payment (from Stripe test mode or the QB mock) flows: ingested → normalized → published to the local queue → consumed by the processor → row written to local SQL → confirmation logged → visible via `GET /transactions` on the reconciliation API.

Cross-checked: every clause maps to a verification step above — `stripe trigger` / `mock:qb` (ingested), `normalize.ts` + its tests (normalized), `RedisQueuePublisher`/`RedisQueueConsumer` (published/consumed via the local queue), the `INSERT` in `processor/src/index.ts` (row written), `ConsoleEmailSender` (confirmation logged), `GET /transactions` (visible via reconciliation API). Scope deliberately excludes: containerizing the three Node services (Phase 3), any cloud resource (Phase 4+), and a resolved status-vocabulary mapping (flagged as open in `contracts.md`, not decided here).
