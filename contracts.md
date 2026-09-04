# contracts.md — PayBridge Data Flow & Schema Contracts

Working reference for the event flow, the common schema, and a worked example. This reflects **Option A**: normalize and store both sources independently, no auto-matching/merging between a Stripe record and a QuickBooks record. See `CLAUDE.md` for full project context.

## 1. Chronological flow

```
1. A real payment happens in Stripe test mode.
   Independently, a timer fires and emits a mock QuickBooks invoice payload.
   (These two triggers are unrelated and asynchronous — neither waits on the other.)

2. Stripe sends a webhook to the Ingest API (POST /webhooks/stripe).
   The QuickBooks mock feed sends its payload to the Ingest API (POST /webhooks/quickbooks).
   Source is known immediately from which endpoint received the payload —
   it is never inferred from payload contents.

3. Only the Stripe payload is signature-verified (proves it really came from
   Stripe, not spoofed). The QuickBooks payload has nothing to verify — it's
   our own mock, not an external system we need to authenticate.

4. Ingest API normalizes each payload into the COMMON SCHEMA (section 2).
   One normalized JSON object per event. Normalization means matching field
   NAMES and VALUE FORMATS/UNITS (e.g. Stripe's cents → dollars), not just names.

5. Ingest API publishes the normalized object to the Service Bus topic
   ("payments"). One event in, one message out — no batching across sources.

6. The topic routes the message to a subscription based on its `source`
   field (this is "bifurcation" — routing, not decision-making; source was
   already known back in step 2).

7. Processor consumes the message from whichever subscription it landed on.

8. Processor writes the normalized record to Azure SQL as its OWN row.
   No merging with any other record. A Stripe event and a QuickBooks event
   about the "same" real-world purchase are stored as two independent rows,
   distinguished only by the `source` field.

9. Processor sends a confirmation email to the seller for that event.

10. Anytime later, the record can be queried via the Reconciliation API
    (GET /transactions?source=stripe|qb) — read-only, no matching logic.
```

## 2. Common schema

Every normalized record — regardless of source — has this shape:

| field | type | notes |
|---|---|---|
| `record_id` | uuid | generated internally on write |
| `source` | `"stripe"` \| `"qb"` | set by which endpoint received the payload |
| `source_event_id` | string | the source's own id (Stripe charge id / QB invoice id) — used for idempotency/dedupe |
| `amount` | decimal | always in whole currency units (dollars), never cents |
| `currency` | string | ISO code, e.g. `"USD"` |
| `customer_name` | string | |
| `description` | string | |
| `status` | string | **open question — see section 4** |
| `event_timestamp` | ISO 8601 | when the event occurred at the source |

## 3. Worked example — John buys a $20 pizza

Two independent events fire: the real Stripe charge, and the QuickBooks mock invoice for the same purchase.

### Event 1: Stripe

**Raw webhook payload** (`POST /webhooks/stripe`):
```json
{
  "id": "evt_1NxAB2K",
  "type": "charge.succeeded",
  "data": {
    "object": {
      "id": "ch_3NxAB2K",
      "amount": 2000,
      "currency": "usd",
      "billing_details": { "name": "John Smith", "email": "john@example.com" },
      "description": "Pizza order #482",
      "status": "succeeded",
      "created": 1767456000
    }
  }
}
```
Stripe gives `amount` in cents (2000 = $20.00) and nests the customer name under `data.object.billing_details.name`.

**After normalization:**
```json
{
  "source": "stripe",
  "source_event_id": "ch_3NxAB2K",
  "amount": 20.00,
  "currency": "USD",
  "customer_name": "John Smith",
  "description": "Pizza order #482",
  "status": "succeeded",
  "event_timestamp": "2026-09-03T14:00:00Z"
}
```

### Event 2: QuickBooks

**Raw mock payload** (`POST /webhooks/quickbooks`):
```json
{
  "invoice_id": "INV-1042",
  "customer": "John Smith",
  "amount_due": 20.00,
  "currency": "USD",
  "memo": "Pizza order #482",
  "status": "paid",
  "issued_date": "2026-09-03"
}
```

**After normalization:**
```json
{
  "source": "qb",
  "source_event_id": "INV-1042",
  "amount": 20.00,
  "currency": "USD",
  "customer_name": "John Smith",
  "description": "Pizza order #482",
  "status": "paid",
  "event_timestamp": "2026-09-03T00:00:00Z"
}
```

### What lands in Azure SQL — two independent rows

| record_id | source | source_event_id | amount | customer_name | description | status | event_timestamp |
|---|---|---|---|---|---|---|---|
| uuid-1 | stripe | ch_3NxAB2K | 20.00 | John Smith | Pizza order #482 | succeeded | 2026-09-03T14:00:00Z |
| uuid-2 | qb | INV-1042 | 20.00 | John Smith | Pizza order #482 | paid | 2026-09-03T00:00:00Z |

Same real-world purchase, two unrelated rows. The system does not know they match — a human (or a future Option B matching engine) would have to notice.

### Reconciliation API responses

```
GET /transactions?source=stripe  →  [ { ...uuid-1 row } ]
GET /transactions?source=qb      →  [ { ...uuid-2 row } ]
```

## 4. Open decisions

- **Status vocabulary:** Stripe says `"succeeded"`, QuickBooks says `"paid"` — same real-world meaning, different word. Decide whether normalization also maps these to one shared vocabulary (e.g. both → `"completed"`) or keeps each source's native status word as-is. Affects the normalize function and any future querying/filtering by status.
