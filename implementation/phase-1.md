# Phase 1 — Local application foundation

Source: `phases.md` → Phase 1. Goal: monorepo skeleton with three services and a shared package, wired together and compiling/starting — no real queue, no real DB, no real email, no normalization logic yet. Those are Phase 2+.

## Steps

1. **Repo layout**
   ```
   paybridge/
   ├── package.json          (root, npm workspaces)
   ├── tsconfig.base.json
   ├── shared/
   └── services/
       ├── ingest-api/
       ├── processor/
       └── reconciliation-api/
   ```

2. **Root workspace config** (`package.json`)
   ```json
   {
     "name": "paybridge",
     "private": true,
     "workspaces": ["shared", "services/*"]
   }
   ```
   npm workspaces means `services/*` can `import` from `shared` as a real package (`@paybridge/shared`) without publishing anything — npm symlinks it locally.

3. **`tsconfig.base.json`** at root — strict mode on (this is money-handling code):
   ```json
   {
     "compilerOptions": {
       "target": "ES2022",
       "module": "commonjs",
       "strict": true,
       "esModuleInterop": true,
       "skipLibCheck": true,
       "outDir": "dist"
     }
   }
   ```
   Each package's own `tsconfig.json` will `extends` this.

4. **`shared/` package** — `@paybridge/shared`
   - `shared/package.json`: name `@paybridge/shared`, `main: dist/index.js`, `types: dist/index.d.ts`. Add `zod` as a dependency.
   - `shared/src/schema.ts` — the common schema from `contracts.md`, as a Zod schema + inferred type:
     ```ts
     import { z } from "zod";

     export const PaymentRecordSchema = z.object({
       record_id: z.string().uuid(),
       source: z.enum(["stripe", "qb"]),
       source_event_id: z.string(),
       amount: z.number(),
       currency: z.string(),
       customer_name: z.string(),
       description: z.string(),
       status: z.string(),
       event_timestamp: z.string().datetime(),
     });

     export type PaymentRecord = z.infer<typeof PaymentRecordSchema>;
     ```
   - `shared/src/queue.ts` — interface only, no implementation:
     ```ts
     import type { PaymentRecord } from "./schema";

     export interface QueuePublisher {
       publish(event: PaymentRecord): Promise<void>;
     }

     export interface QueueConsumer {
       consume(handler: (event: PaymentRecord) => Promise<void>): void;
     }
     ```
   - `shared/src/email.ts` — interface only, no implementation:
     ```ts
     import type { PaymentRecord } from "./schema";

     export interface EmailSender {
       sendConfirmation(record: PaymentRecord): Promise<void>;
     }
     ```
   - `shared/src/index.ts` — re-export all of the above.

5. **Each service package** (`ingest-api`, `processor`, `reconciliation-api`)
   - Own `package.json` depending on `@paybridge/shared` (npm workspaces resolves this to the local folder automatically).
   - Own `tsconfig.json` extending the root base config.
   - `ingest-api` and `reconciliation-api` additionally depend on `express`.

6. **Stub (no-op) implementations** — these exist only to prove the interfaces compile and something concrete can be plugged in; they intentionally do nothing useful yet. Real working versions are Phase 2.
   - e.g. in `ingest-api/src/noopQueue.ts`:
     ```ts
     import type { QueuePublisher } from "@paybridge/shared";

     export class NoopQueuePublisher implements QueuePublisher {
       async publish(): Promise<void> {
         // no-op — real implementation in Phase 2
       }
     }
     ```
   - Same pattern for a `NoopQueueConsumer` in `processor`, and a `NoopEmailSender` in `processor` (`processor` is the one that sends the confirmation, per the corrected flow — it's the only service that needs the `email` interface).

7. **Minimal entrypoints** — enough to start, not enough to do real work yet:
   - `ingest-api/src/index.ts`: Express app, listens on a port, one placeholder route (e.g. `POST /webhooks/stripe`) that imports `PaymentRecordSchema` and `NoopQueuePublisher` and calls `.publish()` — proving the wiring, not implementing signature verification or normalization (that's Phase 2).
   - `processor/src/index.ts`: no Express — this is a worker. Just imports `NoopQueueConsumer` and `NoopEmailSender`, calls `.consume()` with a handler that does nothing yet, and logs "processor started" so you can see it's alive.
   - `reconciliation-api/src/index.ts`: Express app, listens on a port, one placeholder route `GET /transactions` returning an empty array — no real DB read yet (no DB exists until Phase 2).

8. **Root scripts** to build/run everything via workspaces, e.g.:
   ```json
   "scripts": {
     "build": "npm run build --workspaces --if-present",
     "dev:ingest": "npm run dev -w services/ingest-api",
     "dev:processor": "npm run dev -w services/processor",
     "dev:reconciliation": "npm run dev -w services/reconciliation-api"
   }
   ```
   Each service's own `dev` script runs it via `tsx` (or `ts-node`) against `src/index.ts`.

## Verification

```
npm install
npm run build
npm run dev:ingest          # separate terminal — should start and log "listening on port ..."
npm run dev:processor       # separate terminal — should start and log "processor started"
npm run dev:reconciliation  # separate terminal — should start and log "listening on port ..."
```

All three must start without TypeScript compile errors and without crashing, and each must be importing something from `@paybridge/shared` (schema type + the relevant no-op interface implementation) — not just standalone Express apps that happen to sit in the same repo.

## Definition of Done (from `phases.md`)

> All three services compile and start, importing shared types, with stub (no-op) implementations of queue and email.

Cross-checked: no normalization logic, no real queue transport, no real DB, no real email sending is in scope here — all of that is Phase 2 ("Local integration"). This phase only proves the skeleton holds together.
